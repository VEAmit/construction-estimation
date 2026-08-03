/*
    BuildTakeoff Pro - Move Member Schedule to Project Level

    IMPORTANT:
    1. In SSMS, select the client's BuildTakeoff Pro database before running.
    2. Take a database backup first.
    3. This script is safe to run again. It also records the matching EF Core
       migration so the deployed API does not try to apply the same change twice.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.Projects', N'U') IS NULL
        THROW 51000, 'Projects table was not found. Select the correct database and run the script again.', 1;

    IF OBJECT_ID(N'dbo.Drawings', N'U') IS NULL
        THROW 51001, 'Drawings table was not found. Select the correct database and run the script again.', 1;

    IF OBJECT_ID(N'dbo.MemberScheduleItems', N'U') IS NULL
        THROW 51002, 'MemberScheduleItems table was not found. Select the correct database and run the script again.', 1;

    IF OBJECT_ID(N'dbo.TakeoffItems', N'U') IS NULL
        THROW 51003, 'TakeoffItems table was not found. Select the correct database and run the script again.', 1;

    IF OBJECT_ID(N'dbo.__EFMigrationsHistory', N'U') IS NULL
        THROW 51004, 'EF migration history was not found. Do not run this script against an uninitialized database.', 1;

    IF COL_LENGTH(N'dbo.MemberScheduleItems', N'ProjectId') IS NULL
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems
            ADD ProjectId int NULL;
    END;

    /* Backfill every legacy drawing-level schedule row with its project. */
    UPDATE schedule
    SET schedule.ProjectId = drawing.ProjectId
    FROM dbo.MemberScheduleItems AS schedule
    INNER JOIN dbo.Drawings AS drawing
        ON drawing.Id = schedule.DrawingId
    WHERE schedule.ProjectId IS NULL;

    IF EXISTS (SELECT 1 FROM dbo.MemberScheduleItems WHERE ProjectId IS NULL)
        THROW 51005, 'One or more schedule rows could not be linked to a project. No changes were committed.', 1;

    UPDATE dbo.MemberScheduleItems
    SET Mark = LTRIM(RTRIM(Mark));

    /*
       Keep the most recently updated row for each Project + Mark. Duplicate
       rows are soft-deleted, and existing msi:<id> measurement links are
       redirected to the retained row.
    */
    IF OBJECT_ID(N'tempdb..#MemberScheduleMerge', N'U') IS NOT NULL
        DROP TABLE #MemberScheduleMerge;

    CREATE TABLE #MemberScheduleMerge
    (
        DuplicateId int NOT NULL PRIMARY KEY,
        KeeperId int NOT NULL
    );

    ;WITH RankedMembers AS
    (
        SELECT
            Id,
            FIRST_VALUE(Id) OVER
            (
                PARTITION BY ProjectId, UPPER(LTRIM(RTRIM(Mark)))
                ORDER BY UpdatedAt DESC, Id DESC
            ) AS KeeperId,
            ROW_NUMBER() OVER
            (
                PARTITION BY ProjectId, UPPER(LTRIM(RTRIM(Mark)))
                ORDER BY UpdatedAt DESC, Id DESC
            ) AS RowNumber
        FROM dbo.MemberScheduleItems
        WHERE IsDeleted = 0
          AND LTRIM(RTRIM(Mark)) <> N''
    )
    INSERT INTO #MemberScheduleMerge (DuplicateId, KeeperId)
    SELECT Id, KeeperId
    FROM RankedMembers
    WHERE RowNumber > 1;

    UPDATE takeoff
    SET Notes = SUBSTRING(rewritten.Value, 2, LEN(rewritten.Value) - 2)
    FROM dbo.TakeoffItems AS takeoff
    INNER JOIN #MemberScheduleMerge AS mergeMap
        ON CHARINDEX(
            CONCAT(N';msi:', mergeMap.DuplicateId, N';'),
            CONCAT(N';', takeoff.Notes, N';')) > 0
    CROSS APPLY
    (
        VALUES
        (
            REPLACE(
                CONCAT(N';', takeoff.Notes, N';'),
                CONCAT(N';msi:', mergeMap.DuplicateId, N';'),
                CONCAT(N';msi:', mergeMap.KeeperId, N';'))
        )
    ) AS rewritten(Value);

    UPDATE schedule
    SET IsDeleted = 1,
        UpdatedAt = SYSUTCDATETIME()
    FROM dbo.MemberScheduleItems AS schedule
    INNER JOIN #MemberScheduleMerge AS mergeMap
        ON mergeMap.DuplicateId = schedule.Id;

    DROP TABLE #MemberScheduleMerge;

    /* Replace the old drawing cascade relationship with an optional source reference. */
    IF EXISTS
    (
        SELECT 1
        FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
          AND name = N'FK_MemberScheduleItems_Drawings_DrawingId'
    )
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems
            DROP CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId;
    END;

    ALTER TABLE dbo.MemberScheduleItems
        ALTER COLUMN DrawingId int NULL;

    ALTER TABLE dbo.MemberScheduleItems
        ALTER COLUMN ProjectId int NOT NULL;

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
          AND name = N'FK_MemberScheduleItems_Drawings_DrawingId'
    )
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems WITH CHECK
            ADD CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId
                FOREIGN KEY (DrawingId) REFERENCES dbo.Drawings(Id);

        ALTER TABLE dbo.MemberScheduleItems
            CHECK CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId;
    END;

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
          AND name = N'FK_MemberScheduleItems_Projects_ProjectId'
    )
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems WITH CHECK
            ADD CONSTRAINT FK_MemberScheduleItems_Projects_ProjectId
                FOREIGN KEY (ProjectId) REFERENCES dbo.Projects(Id)
                ON DELETE CASCADE;

        ALTER TABLE dbo.MemberScheduleItems
            CHECK CONSTRAINT FK_MemberScheduleItems_Projects_ProjectId;
    END;

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MemberScheduleItems')
          AND name = N'IX_MemberScheduleItems_ProjectId_Mark'
    )
    BEGIN
        CREATE UNIQUE INDEX IX_MemberScheduleItems_ProjectId_Mark
            ON dbo.MemberScheduleItems(ProjectId, Mark)
            WHERE IsDeleted = 0 AND Mark <> N'';
    END;

    IF NOT EXISTS
    (
        SELECT 1
        FROM dbo.__EFMigrationsHistory
        WHERE MigrationId = N'20260803130000_MoveMemberScheduleToProject'
    )
    BEGIN
        INSERT INTO dbo.__EFMigrationsHistory (MigrationId, ProductVersion)
        VALUES (N'20260803130000_MoveMemberScheduleToProject', N'8.0.0');
    END;

    COMMIT TRANSACTION;

    PRINT 'Project-level Member Schedule migration completed successfully.';

    /* Send this result to the administrator if a Project ID is required. */
    SELECT
        Id AS ProjectId,
        ProjectNumber,
        Name AS ProjectName
    FROM dbo.Projects
    WHERE IsDeleted = 0
    ORDER BY Id;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;

    THROW;
END CATCH;

