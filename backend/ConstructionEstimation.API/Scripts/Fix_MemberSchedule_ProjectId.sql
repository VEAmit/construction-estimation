/*
================================================================================
 BuildTakeoff Pro — Member Schedule "per project" schema fix
 Reconciles migration 20260803130000_MoveMemberScheduleToProject
================================================================================

 WHAT THIS FIXES
   HTTP 500 when saving an extracted member schedule:
     "Cannot insert the value NULL into column 'ProjectId',
      table 'MemberScheduleItems'; column does not allow nulls."
   ...and/or this warning on every API startup:
     "Database migration failed - will attempt EnsureCreated"
     "Column name 'ProjectId' ... is specified more than once."

 WHO SHOULD RUN IT
   Any machine whose database has NOT had migration
   20260803130000_MoveMemberScheduleToProject applied cleanly. That includes
   machines where the ProjectId column was added by hand.

 SAFE TO RUN WHEN
   - The column was added by hand (partial state)      -> completes the rest
   - The column was never added at all                 -> does everything
   - The migration already applied correctly           -> does nothing, exits
   It is idempotent: running it twice is harmless.

 BEFORE RUNNING
   1. STOP the BuildTakeoff Pro API / IIS site. Do not run against a live app.
   2. TAKE A DATABASE BACKUP. This script edits MemberScheduleItems and can
      rewrite msi: links inside TakeoffItems.Notes.

 HOW TO RUN
   SSMS:    open, select the correct database, Execute.
   sqlcmd:  sqlcmd -S .\SQLEXPRESS2019 -d ConstructionEstimationDB -E ^
                   -i Fix_MemberSchedule_ProjectId.sql

 BEHAVIOUR
   Runs as ONE transaction. Any error rolls the whole thing back and prints a
   message - the database is left exactly as it was. Nothing is half-applied.

 NOTE ON DUPLICATES
   The migration makes (ProjectId, Mark) unique per project. Where a project
   has duplicate marks, the most recently updated row is KEPT and the others
   are SOFT-deleted (IsDeleted = 1, not physically removed). Any takeoff item
   pointing at a removed duplicate is re-pointed at the kept row, so no
   measurement loses its member link.
================================================================================
*/

/* REQUIRED. The unique index in step 8 is a FILTERED index, and SQL Server
   refuses to create one unless QUOTED_IDENTIFIER is ON. SSMS turns it on for
   you; sqlcmd does NOT. Without these two lines the script works in SSMS and
   fails from the command line - so they are set explicitly here. */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @MigrationId  nvarchar(150) = N'20260803130000_MoveMemberScheduleToProject';
DECLARE @ProductVer   nvarchar(32)  = N'8.0.0';
DECLARE @Applied      bit = 0;

PRINT '=====================================================';
PRINT ' Member Schedule ProjectId fix';
PRINT ' Database: ' + DB_NAME();
PRINT '=====================================================';

/*--------------------------------------------------------------------------
  Guard 0: the tables we need must exist.
--------------------------------------------------------------------------*/
IF OBJECT_ID(N'dbo.MemberScheduleItems', N'U') IS NULL
BEGIN
    PRINT 'ERROR: dbo.MemberScheduleItems not found. Wrong database selected?';
    PRINT 'Aborted. Nothing was changed.';
    RETURN;
END;

IF OBJECT_ID(N'dbo.__EFMigrationsHistory', N'U') IS NULL
BEGIN
    PRINT 'ERROR: __EFMigrationsHistory not found. This is not an EF database.';
    PRINT 'Aborted. Nothing was changed.';
    RETURN;
END;

/*--------------------------------------------------------------------------
  Guard 1: already fully applied? Then there is nothing to do.
--------------------------------------------------------------------------*/
IF EXISTS (SELECT 1 FROM dbo.__EFMigrationsHistory WHERE MigrationId = @MigrationId)
   AND EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                 AND name = N'IX_MemberScheduleItems_ProjectId_Mark')
BEGIN
    PRINT 'Migration already applied and schema is complete. Nothing to do.';
    RETURN;
END;

BEGIN TRY
BEGIN TRANSACTION;

    /*----------------------------------------------------------------------
      STEP 1 - ProjectId column (nullable for now, so we can backfill).
    ----------------------------------------------------------------------*/
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                     AND name = N'ProjectId')
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems ADD ProjectId int NULL;
        PRINT 'STEP 1: ProjectId column added.';
    END
    ELSE
        PRINT 'STEP 1: ProjectId column already present - skipped.';

    /* Everything below touches ProjectId, which may have just been created in
       this same batch. SQL Server will not compile a direct reference to it
       yet, so those statements go through EXEC(). This is the single most
       common reason a hand-written version of this script fails. */

    /*----------------------------------------------------------------------
      STEP 2 - Backfill ProjectId from each row's drawing.
    ----------------------------------------------------------------------*/
    /* NULL *and* 0 both count as "not set yet". A hand-added column is often
       created as NOT NULL DEFAULT 0, which leaves every existing row at 0 -
       those rows must still be backfilled or the Projects FK in step 9 fails. */
    EXEC(N'
        UPDATE schedule
           SET schedule.ProjectId = drawing.ProjectId
          FROM dbo.MemberScheduleItems AS schedule
         INNER JOIN dbo.Drawings AS drawing ON drawing.Id = schedule.DrawingId
         WHERE schedule.ProjectId IS NULL OR schedule.ProjectId = 0;');
    PRINT 'STEP 2: ProjectId backfilled from Drawings.';

    /*----------------------------------------------------------------------
      STEP 3 - Any row we could not resolve to a project is fatal. Rather
      than guessing, stop and let a human look at it.
    ----------------------------------------------------------------------*/
    DECLARE @Orphans int;
    DECLARE @OrphanOut nvarchar(max) = N'SELECT @c = COUNT(*) FROM dbo.MemberScheduleItems WHERE ProjectId IS NULL OR ProjectId = 0;';
    EXEC sp_executesql @OrphanOut, N'@c int OUTPUT', @c = @Orphans OUTPUT;

    IF @Orphans > 0
    BEGIN
        DECLARE @msg nvarchar(400) =
            N'Found ' + CAST(@Orphans AS nvarchar(10)) +
            N' member schedule row(s) whose DrawingId matches no drawing, so no project could be resolved. Resolve these rows first.';
        THROW 51000, @msg, 1;
    END;
    PRINT 'STEP 3: All rows resolved to a project.';

    /*----------------------------------------------------------------------
      STEP 4 - Normalise marks (trailing spaces would defeat the unique index).
    ----------------------------------------------------------------------*/
    UPDATE dbo.MemberScheduleItems
       SET Mark = LTRIM(RTRIM(Mark))
     WHERE Mark <> LTRIM(RTRIM(Mark));
    PRINT 'STEP 4: Marks trimmed.';

    /*----------------------------------------------------------------------
      STEP 5 - Merge duplicate marks within a project.
      Keep the newest row; soft-delete the rest; re-point takeoff links.
    ----------------------------------------------------------------------*/
    IF OBJECT_ID(N'tempdb..#MemberScheduleMerge') IS NOT NULL
        DROP TABLE #MemberScheduleMerge;

    CREATE TABLE #MemberScheduleMerge
    (
        DuplicateId int NOT NULL PRIMARY KEY,
        KeeperId    int NOT NULL
    );

    EXEC(N'
        ;WITH RankedMembers AS
        (
            SELECT
                Id,
                FIRST_VALUE(Id) OVER (
                    PARTITION BY ProjectId, UPPER(LTRIM(RTRIM(Mark)))
                    ORDER BY UpdatedAt DESC, Id DESC) AS KeeperId,
                ROW_NUMBER() OVER (
                    PARTITION BY ProjectId, UPPER(LTRIM(RTRIM(Mark)))
                    ORDER BY UpdatedAt DESC, Id DESC) AS RowNumber
              FROM dbo.MemberScheduleItems
             WHERE IsDeleted = 0 AND LTRIM(RTRIM(Mark)) <> N''''
        )
        INSERT INTO #MemberScheduleMerge (DuplicateId, KeeperId)
        SELECT Id, KeeperId FROM RankedMembers WHERE RowNumber > 1;');

    DECLARE @Dupes int = (SELECT COUNT(*) FROM #MemberScheduleMerge);

    IF @Dupes > 0 AND OBJECT_ID(N'dbo.TakeoffItems', N'U') IS NOT NULL
    BEGIN
        UPDATE takeoff
           SET Notes = SUBSTRING(rewritten.Value, 2, LEN(rewritten.Value) - 2)
          FROM dbo.TakeoffItems AS takeoff
         INNER JOIN #MemberScheduleMerge AS mergeMap
            ON CHARINDEX(CONCAT(N';msi:', mergeMap.DuplicateId, N';'),
                         CONCAT(N';', takeoff.Notes, N';')) > 0
         CROSS APPLY (VALUES (REPLACE(CONCAT(N';', takeoff.Notes, N';'),
                                      CONCAT(N';msi:', mergeMap.DuplicateId, N';'),
                                      CONCAT(N';msi:', mergeMap.KeeperId, N';'))))
                     AS rewritten(Value);
    END;

    UPDATE schedule
       SET IsDeleted = 1,
           UpdatedAt = SYSUTCDATETIME()
      FROM dbo.MemberScheduleItems AS schedule
     INNER JOIN #MemberScheduleMerge AS mergeMap ON mergeMap.DuplicateId = schedule.Id;

    DROP TABLE #MemberScheduleMerge;
    PRINT 'STEP 5: ' + CAST(@Dupes AS varchar(10)) + ' duplicate mark(s) merged.';

    /*----------------------------------------------------------------------
      STEP 6 - ProjectId becomes NOT NULL.
    ----------------------------------------------------------------------*/
    IF EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                 AND name = N'ProjectId' AND is_nullable = 1)
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems ALTER COLUMN ProjectId int NOT NULL;
        PRINT 'STEP 6: ProjectId set to NOT NULL.';
    END
    ELSE
        PRINT 'STEP 6: ProjectId already NOT NULL - skipped.';

    /*----------------------------------------------------------------------
      STEP 7 - DrawingId becomes optional (it is now only source metadata).
      The index on it is dropped and rebuilt around the change.
    ----------------------------------------------------------------------*/
    IF EXISTS (SELECT 1 FROM sys.foreign_keys
               WHERE name = N'FK_MemberScheduleItems_Drawings_DrawingId'
                 AND parent_object_id = OBJECT_ID(N'dbo.MemberScheduleItems'))
        ALTER TABLE dbo.MemberScheduleItems
            DROP CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId;

    IF EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                 AND name = N'IX_MemberScheduleItems_DrawingId')
        DROP INDEX IX_MemberScheduleItems_DrawingId ON dbo.MemberScheduleItems;

    IF EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                 AND name = N'DrawingId' AND is_nullable = 0)
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems ALTER COLUMN DrawingId int NULL;
        PRINT 'STEP 7: DrawingId set to NULL-able.';
    END
    ELSE
        PRINT 'STEP 7: DrawingId already NULL-able - skipped.';

    CREATE INDEX IX_MemberScheduleItems_DrawingId
        ON dbo.MemberScheduleItems (DrawingId);

    /* Re-added WITHOUT cascade on purpose: the Projects FK below cascades, and
       two cascade paths into one table is an error in SQL Server. */
    ALTER TABLE dbo.MemberScheduleItems
        ADD CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId
        FOREIGN KEY (DrawingId) REFERENCES dbo.Drawings (Id);

    /*----------------------------------------------------------------------
      STEP 8 - Unique mark per project (this is the guard that stops
      duplicate members being created).
    ----------------------------------------------------------------------*/
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                     AND name = N'IX_MemberScheduleItems_ProjectId_Mark')
    BEGIN
        EXEC(N'
            CREATE UNIQUE INDEX IX_MemberScheduleItems_ProjectId_Mark
                ON dbo.MemberScheduleItems (ProjectId, Mark)
             WHERE [IsDeleted] = 0 AND [Mark] <> N'''''''';');
        PRINT 'STEP 8: Unique index (ProjectId, Mark) created.';
    END
    ELSE
        PRINT 'STEP 8: Unique index already present - skipped.';

    /*----------------------------------------------------------------------
      STEP 9 - Foreign key to Projects.
    ----------------------------------------------------------------------*/
    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys
                   WHERE name = N'FK_MemberScheduleItems_Projects_ProjectId'
                     AND parent_object_id = OBJECT_ID(N'dbo.MemberScheduleItems'))
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems
            ADD CONSTRAINT FK_MemberScheduleItems_Projects_ProjectId
            FOREIGN KEY (ProjectId) REFERENCES dbo.Projects (Id) ON DELETE CASCADE;
        PRINT 'STEP 9: Foreign key to Projects created.';
    END
    ELSE
        PRINT 'STEP 9: Foreign key to Projects already present - skipped.';

    /*----------------------------------------------------------------------
      STEP 10 - Record the migration so EF stops trying to re-run it.
      This is what silences the startup warning.
    ----------------------------------------------------------------------*/
    IF NOT EXISTS (SELECT 1 FROM dbo.__EFMigrationsHistory WHERE MigrationId = @MigrationId)
    BEGIN
        INSERT INTO dbo.__EFMigrationsHistory (MigrationId, ProductVersion)
        VALUES (@MigrationId, @ProductVer);
        PRINT 'STEP 10: Migration recorded in __EFMigrationsHistory.';
    END
    ELSE
        PRINT 'STEP 10: Migration already recorded - skipped.';

COMMIT TRANSACTION;
SET @Applied = 1;

PRINT '';
PRINT '=====================================================';
PRINT ' SUCCESS - all changes committed.';
PRINT ' Restart the BuildTakeoff Pro API now.';
PRINT '=====================================================';

END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;

    IF OBJECT_ID(N'tempdb..#MemberScheduleMerge') IS NOT NULL
        DROP TABLE #MemberScheduleMerge;

    PRINT '';
    PRINT '=====================================================';
    PRINT ' FAILED - everything was rolled back.';
    PRINT ' The database is unchanged. Nothing was half-applied.';
    PRINT '=====================================================';
    PRINT 'Error   : ' + ERROR_MESSAGE();
    PRINT 'Line    : ' + CAST(ERROR_LINE() AS varchar(10));
END CATCH;
GO

/*--------------------------------------------------------------------------
  VERIFICATION - read-only. Expect 4 rows, all saying OK.
--------------------------------------------------------------------------*/
PRINT '';
PRINT 'Verification:';

SELECT
    Check_Name = 'ProjectId column is NOT NULL',
    Result     = CASE WHEN EXISTS (SELECT 1 FROM sys.columns
                                   WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                                     AND name = N'ProjectId' AND is_nullable = 0)
                      THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT
    'DrawingId column is NULL-able',
    CASE WHEN EXISTS (SELECT 1 FROM sys.columns
                      WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                        AND name = N'DrawingId' AND is_nullable = 1)
         THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT
    'Unique index (ProjectId, Mark)',
    CASE WHEN EXISTS (SELECT 1 FROM sys.indexes
                      WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
                        AND name = N'IX_MemberScheduleItems_ProjectId_Mark')
         THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT
    'Migration history row',
    CASE WHEN EXISTS (SELECT 1 FROM dbo.__EFMigrationsHistory
                      WHERE MigrationId = N'20260803130000_MoveMemberScheduleToProject')
         THEN 'OK' ELSE 'MISSING' END;
GO
