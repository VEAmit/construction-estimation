/*
   Use this short script only when MemberScheduleItems contains no data.
   Select the correct Construction Estimation database in SSMS before running.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF EXISTS (SELECT 1 FROM dbo.MemberScheduleItems)
        THROW 51000, 'MemberScheduleItems contains data. Use the full migration script instead.', 1;

    IF COL_LENGTH(N'dbo.MemberScheduleItems', N'ProjectId') IS NULL
    BEGIN
        ALTER TABLE dbo.MemberScheduleItems
            ADD ProjectId int NULL;
    END;

    ALTER TABLE dbo.MemberScheduleItems
        ALTER COLUMN ProjectId int NOT NULL;

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

    ALTER TABLE dbo.MemberScheduleItems WITH CHECK
        ADD CONSTRAINT FK_MemberScheduleItems_Drawings_DrawingId
            FOREIGN KEY (DrawingId) REFERENCES dbo.Drawings(Id);

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

    IF OBJECT_ID(N'dbo.__EFMigrationsHistory', N'U') IS NOT NULL
       AND NOT EXISTS
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

    PRINT 'ProjectId added successfully.';

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

