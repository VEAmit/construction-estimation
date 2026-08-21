using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations;

[DbContext(typeof(AppDbContext))]
[Migration("20260821120000_AddMeasurementSectionColors")]
public partial class AddMeasurementSectionColors : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "Color",
            table: "MeasurementSections",
            type: "nvarchar(7)",
            maxLength: 7,
            nullable: false,
            defaultValue: "#3B82F6");

        // Give every existing group a stable project-local palette color. New
        // groups are assigned the first unused color by the API.
        migrationBuilder.Sql(
            """
            WITH RankedSections AS
            (
                SELECT Id,
                       (ROW_NUMBER() OVER (PARTITION BY ProjectId ORDER BY Id) - 1) % 12 AS ColorIndex
                FROM MeasurementSections
                WHERE IsDeleted = 0
            )
            UPDATE sectionRow
            SET Color = CASE ranked.ColorIndex
                WHEN 0 THEN '#3B82F6'
                WHEN 1 THEN '#22C55E'
                WHEN 2 THEN '#F97316'
                WHEN 3 THEN '#A855F7'
                WHEN 4 THEN '#06B6D4'
                WHEN 5 THEN '#EAB308'
                WHEN 6 THEN '#EC4899'
                WHEN 7 THEN '#EF4444'
                WHEN 8 THEN '#14B8A6'
                WHEN 9 THEN '#F59E0B'
                WHEN 10 THEN '#6366F1'
                ELSE '#84CC16'
            END
            FROM MeasurementSections AS sectionRow
            INNER JOIN RankedSections AS ranked ON ranked.Id = sectionRow.Id;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "Color",
            table: "MeasurementSections");
    }
}
