namespace ConstructionEstimation.Core.Entities;

public class MemberScheduleItem : BaseEntity
{
    public string Mark { get; set; } = string.Empty;
    public string MemberSize { get; set; } = string.Empty;
    public string MemberType { get; set; } = string.Empty;
    public double UnitWeight { get; set; }
    public double Length { get; set; }
    public int Quantity { get; set; } = 1;
    public double TotalWeight { get; set; }
    public string Description { get; set; } = string.Empty;

    // The member schedule is owned by the project and shared by every drawing
    // in that project. DrawingId is retained as optional source metadata so
    // existing records and API clients remain compatible after migration.
    public int ProjectId { get; set; }
    public Project Project { get; set; } = null!;

    public int? DrawingId { get; set; }
    public Drawing? Drawing { get; set; }

    // Optional link to a line measurement entry
    public int? TakeoffItemId { get; set; }

    public string? Color { get; set; }
}
