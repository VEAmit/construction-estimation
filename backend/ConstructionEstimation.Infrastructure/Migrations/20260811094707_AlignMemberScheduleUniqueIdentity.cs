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
            migrationBuilder.DropIndex(
                name: "IX_MemberScheduleItems_ProjectId_Mark",
                table: "MemberScheduleItems");

            migrationBuilder.CreateIndex(
                name: "IX_MemberScheduleItems_ProjectId_Mark_MemberSize",
                table: "MemberScheduleItems",
                columns: new[] { "ProjectId", "Mark", "MemberSize" },
                unique: true,
                filter: "[IsDeleted] = 0 AND [Mark] <> N''");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_MemberScheduleItems_ProjectId_Mark_MemberSize",
                table: "MemberScheduleItems");

            migrationBuilder.CreateIndex(
                name: "IX_MemberScheduleItems_ProjectId_Mark",
                table: "MemberScheduleItems",
                columns: new[] { "ProjectId", "Mark" },
                unique: true,
                filter: "[IsDeleted] = 0 AND [Mark] <> N''");
        }
    }
}
