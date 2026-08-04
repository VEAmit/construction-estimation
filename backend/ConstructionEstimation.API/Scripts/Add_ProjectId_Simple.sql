/* BuildTakeoff Pro - add ProjectId to MemberScheduleItems.
   Select the correct database in SSMS, then Execute (F5).
   Safe to run twice. Stop the app first. */

SET XACT_ABORT ON;
BEGIN TRAN;

-- 1. add the column
IF COL_LENGTH('dbo.MemberScheduleItems', 'ProjectId') IS NULL
    ALTER TABLE dbo.MemberScheduleItems ADD ProjectId int NULL;

-- 2. fill it in from each row's drawing
EXEC('UPDATE s SET s.ProjectId = d.ProjectId
      FROM dbo.MemberScheduleItems s
      JOIN dbo.Drawings d ON d.Id = s.DrawingId
      WHERE s.ProjectId IS NULL OR s.ProjectId = 0;');

-- 3. lock it down
EXEC('ALTER TABLE dbo.MemberScheduleItems ALTER COLUMN ProjectId int NOT NULL;');

-- 4. tell EF the migration is done, so it stops retrying it on startup
IF NOT EXISTS (SELECT 1 FROM dbo.__EFMigrationsHistory
               WHERE MigrationId = '20260803130000_MoveMemberScheduleToProject')
    INSERT INTO dbo.__EFMigrationsHistory (MigrationId, ProductVersion)
    VALUES ('20260803130000_MoveMemberScheduleToProject', '8.0.0');

COMMIT;

SELECT ProjectIdColumn = COL_LENGTH('dbo.MemberScheduleItems', 'ProjectId');
-- a number = done. NULL = column missing, send us the error message.
