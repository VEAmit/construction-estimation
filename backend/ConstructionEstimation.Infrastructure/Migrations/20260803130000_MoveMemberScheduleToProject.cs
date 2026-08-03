using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations;

/// <summary>
/// Makes a single member schedule authoritative for the whole project while
/// retaining the original drawing reference as optional source metadata.
/// Existing duplicate marks are soft-deleted and legacy msi:&lt;id&gt; links are
/// redirected to the retained project-level item.
/// </summary>
[DbContext(typeof(AppDbContext))]
[Migration("20260803130000_MoveMemberScheduleToProject")]
public partial class MoveMemberScheduleToProject : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<int>(
            name: "ProjectId",
            table: "MemberScheduleItems",
            type: "int",
            nullable: true);

        migrationBuilder.Sql(
            """
            UPDATE schedule
            SET schedule.ProjectId = drawing.ProjectId
            FROM dbo.MemberScheduleItems AS schedule
            INNER JOIN dbo.Drawings AS drawing ON drawing.Id = schedule.DrawingId;

            IF EXISTS (SELECT 1 FROM dbo.MemberScheduleItems WHERE ProjectId IS NULL)
                THROW 51000, 'Unable to resolve a project for one or more member schedule items.', 1;

            UPDATE dbo.MemberScheduleItems
            SET Mark = LTRIM(RTRIM(Mark));

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
                WHERE IsDeleted = 0 AND LTRIM(RTRIM(Mark)) <> N''
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
            """);

        migrationBuilder.AlterColumn<int>(
            name: "ProjectId",
            table: "MemberScheduleItems",
            type: "int",
            nullable: false,
            oldClrType: typeof(int),
            oldType: "int",
            oldNullable: true);

        migrationBuilder.DropForeignKey(
            name: "FK_MemberScheduleItems_Drawings_DrawingId",
            table: "MemberScheduleItems");

        migrationBuilder.AlterColumn<int>(
            name: "DrawingId",
            table: "MemberScheduleItems",
            type: "int",
            nullable: true,
            oldClrType: typeof(int),
            oldType: "int");

        migrationBuilder.AddForeignKey(
            name: "FK_MemberScheduleItems_Drawings_DrawingId",
            table: "MemberScheduleItems",
            column: "DrawingId",
            principalTable: "Drawings",
            principalColumn: "Id");

        migrationBuilder.CreateIndex(
            name: "IX_MemberScheduleItems_ProjectId_Mark",
            table: "MemberScheduleItems",
            columns: new[] { "ProjectId", "Mark" },
            unique: true,
            filter: "[IsDeleted] = 0 AND [Mark] <> N''");

        migrationBuilder.AddForeignKey(
            name: "FK_MemberScheduleItems_Projects_ProjectId",
            table: "MemberScheduleItems",
            column: "ProjectId",
            principalTable: "Projects",
            principalColumn: "Id",
            onDelete: ReferentialAction.Cascade);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropForeignKey(
            name: "FK_MemberScheduleItems_Drawings_DrawingId",
            table: "MemberScheduleItems");

        migrationBuilder.DropForeignKey(
            name: "FK_MemberScheduleItems_Projects_ProjectId",
            table: "MemberScheduleItems");

        migrationBuilder.DropIndex(
            name: "IX_MemberScheduleItems_ProjectId_Mark",
            table: "MemberScheduleItems");

        migrationBuilder.Sql(
            """
            UPDATE schedule
            SET DrawingId = sourceDrawing.Id
            FROM dbo.MemberScheduleItems AS schedule
            CROSS APPLY
            (
                SELECT TOP (1) drawing.Id
                FROM dbo.Drawings AS drawing
                WHERE drawing.ProjectId = schedule.ProjectId
                ORDER BY drawing.Id
            ) AS sourceDrawing
            WHERE schedule.DrawingId IS NULL;

            DELETE FROM dbo.MemberScheduleItems WHERE DrawingId IS NULL;
            """);

        migrationBuilder.AlterColumn<int>(
            name: "DrawingId",
            table: "MemberScheduleItems",
            type: "int",
            nullable: false,
            defaultValue: 0,
            oldClrType: typeof(int),
            oldType: "int",
            oldNullable: true);

        migrationBuilder.AddForeignKey(
            name: "FK_MemberScheduleItems_Drawings_DrawingId",
            table: "MemberScheduleItems",
            column: "DrawingId",
            principalTable: "Drawings",
            principalColumn: "Id",
            onDelete: ReferentialAction.Cascade);

        migrationBuilder.DropColumn(
            name: "ProjectId",
            table: "MemberScheduleItems");
    }
}
