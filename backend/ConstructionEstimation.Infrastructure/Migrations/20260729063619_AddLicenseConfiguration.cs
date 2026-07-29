using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ConstructionEstimation.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddLicenseConfiguration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "LicenseConfigurations",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    EncryptedLicenseKey = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    EncryptedApiKey = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ApiBaseUrl = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    ValidationEndpoint = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    ApplicationIdentifier = table.Column<string>(type: "nvarchar(150)", maxLength: 150, nullable: false),
                    MachineIdentifier = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    CustomerName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    CompanyName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    LastValidationStatus = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    LastValidatedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    ExpiresAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LicenseConfigurations", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_LicenseConfigurations_IsActive",
                table: "LicenseConfigurations",
                column: "IsActive");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "LicenseConfigurations");
        }
    }
}
