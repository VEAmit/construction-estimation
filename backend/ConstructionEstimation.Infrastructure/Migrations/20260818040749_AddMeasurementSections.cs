using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddMeasurementSections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MeasurementSections",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    TemplateJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    MeasurementCount = table.Column<int>(type: "int", nullable: false),
                    SourceDrawingId = table.Column<int>(type: "int", nullable: false),
                    SourcePageNumber = table.Column<int>(type: "int", nullable: false),
                    ProjectId = table.Column<int>(type: "int", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeasurementSections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MeasurementSections_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "MeasurementSectionPlacements",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    MeasurementSectionId = table.Column<int>(type: "int", nullable: false),
                    DrawingId = table.Column<int>(type: "int", nullable: false),
                    PageNumber = table.Column<int>(type: "int", nullable: false),
                    XRatio = table.Column<double>(type: "float", nullable: false),
                    YRatio = table.Column<double>(type: "float", nullable: false),
                    IsSource = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeasurementSectionPlacements", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MeasurementSectionPlacements_Drawings_DrawingId",
                        column: x => x.DrawingId,
                        principalTable: "Drawings",
                        principalColumn: "Id");
                    table.ForeignKey(
                        name: "FK_MeasurementSectionPlacements_MeasurementSections_MeasurementSectionId",
                        column: x => x.MeasurementSectionId,
                        principalTable: "MeasurementSections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementSectionPlacements_DrawingId",
                table: "MeasurementSectionPlacements",
                column: "DrawingId");

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementSectionPlacements_MeasurementSectionId_DrawingId_PageNumber",
                table: "MeasurementSectionPlacements",
                columns: new[] { "MeasurementSectionId", "DrawingId", "PageNumber" });

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementSections_ProjectId_Name",
                table: "MeasurementSections",
                columns: new[] { "ProjectId", "Name" },
                unique: true,
                filter: "[IsDeleted] = 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MeasurementSectionPlacements");

            migrationBuilder.DropTable(
                name: "MeasurementSections");
        }
    }
}
