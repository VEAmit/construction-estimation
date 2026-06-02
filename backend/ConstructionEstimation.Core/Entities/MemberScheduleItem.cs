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

    public int DrawingId { get; set; }
    public Drawing Drawing { get; set; } = null!;

    // Optional link to a line measurement entry
    public int? TakeoffItemId { get; set; }
}
