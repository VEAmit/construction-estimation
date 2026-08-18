using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AlignMemberScheduleUniqueIdentity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Installations created from different historical scripts do not
            // all contain the old Mark-only index. Keep this migration safe on
            // both shapes so a missing legacy index cannot prevent later
            // migrations (including Measurement Sections) from being applied.
            migrationBuilder.Sql("""
                IF EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE name = N'IX_MemberScheduleItems_ProjectId_Mark'
                      AND object_id = OBJECT_ID(N'[MemberScheduleItems]')
                )
                    DROP INDEX [IX_MemberScheduleItems_ProjectId_Mark] ON [MemberScheduleItems];

                IF NOT EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE name = N'IX_MemberScheduleItems_ProjectId_Mark_MemberSize'
                      AND object_id = OBJECT_ID(N'[MemberScheduleItems]')
                )
                BEGIN
                    IF EXISTS (
                        SELECT 1
                        FROM [MemberScheduleItems]
                        WHERE [IsDeleted] = 0 AND [Mark] <> N''
                        GROUP BY [ProjectId], [Mark], [MemberSize]
                        HAVING COUNT_BIG(*) > 1
                    )
                        CREATE INDEX [IX_MemberScheduleItems_ProjectId_Mark_MemberSize]
                        ON [MemberScheduleItems] ([ProjectId], [Mark], [MemberSize])
                        WHERE [IsDeleted] = 0 AND [Mark] <> N'';
                    ELSE
                        CREATE UNIQUE INDEX [IX_MemberScheduleItems_ProjectId_Mark_MemberSize]
                        ON [MemberScheduleItems] ([ProjectId], [Mark], [MemberSize])
                        WHERE [IsDeleted] = 0 AND [Mark] <> N'';
                END
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE name = N'IX_MemberScheduleItems_ProjectId_Mark_MemberSize'
                      AND object_id = OBJECT_ID(N'[MemberScheduleItems]')
                )
                    DROP INDEX [IX_MemberScheduleItems_ProjectId_Mark_MemberSize] ON [MemberScheduleItems];

                IF NOT EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE name = N'IX_MemberScheduleItems_ProjectId_Mark'
                      AND object_id = OBJECT_ID(N'[MemberScheduleItems]')
                )
                    CREATE UNIQUE INDEX [IX_MemberScheduleItems_ProjectId_Mark]
                    ON [MemberScheduleItems] ([ProjectId], [Mark])
                    WHERE [IsDeleted] = 0 AND [Mark] <> N'';
                """);
        }
    }
}
