/* BuildTakeoff Pro - fix "500 error when opening a project".

   Cause: TakeoffItems is missing the Category and Color columns.
   DO NOT drop MemberScheduleItems - that table is already correct.

   Select the correct database in SSMS, then Execute (F5).
   Safe to run twice. Stop the app first. */

SET XACT_ABORT ON;
BEGIN TRAN;

-- 1. the two missing columns
IF COL_LENGTH('dbo.TakeoffItems', 'Category') IS NULL
    ALTER TABLE dbo.TakeoffItems ADD Category nvarchar(max) NULL;

IF COL_LENGTH('dbo.TakeoffItems', 'Color') IS NULL
    ALTER TABLE dbo.TakeoffItems ADD Color nvarchar(max) NULL;

-- 2. tell EF these migrations are done, so it stops retrying them on startup
INSERT INTO dbo.__EFMigrationsHistory (MigrationId, ProductVersion)
SELECT m.Id, '8.0.0'
FROM (VALUES
    ('20260511091501_InitialCreate'),
    ('20260512120827_AddMemberScheduleAndProjectNumber'),
    ('20260514143746_AddAnnotationDataToDrawing'),
    ('20260527092310_AddColorAndCategoryToTakeoffItem'),
    ('20260702150000_AddColorToMemberScheduleItem'),
    ('20260714121333_AddCalibrationSnapshotToTakeoffItem'),
    ('20260729063619_AddLicenseConfiguration'),
    ('20260803130000_MoveMemberScheduleToProject')
) AS m(Id)
WHERE NOT EXISTS (SELECT 1 FROM dbo.__EFMigrationsHistory h WHERE h.MigrationId = m.Id);

COMMIT;

-- both rows must say OK
SELECT Check_Name = 'TakeoffItems.Category',
       Result     = CASE WHEN COL_LENGTH('dbo.TakeoffItems','Category') IS NULL
                         THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'TakeoffItems.Color',
       CASE WHEN COL_LENGTH('dbo.TakeoffItems','Color') IS NULL
            THEN 'MISSING' ELSE 'OK' END;
