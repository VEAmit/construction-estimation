using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddCalibrationSnapshotToTakeoffItem : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CalibrationUnitAtCreation",
                table: "TakeoffItems",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "ScaleRatioAtCreation",
                table: "TakeoffItems",
                type: "float",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CalibrationUnitAtCreation",
                table: "TakeoffItems");

            migrationBuilder.DropColumn(
                name: "ScaleRatioAtCreation",
                table: "TakeoffItems");
        }
    }
}
