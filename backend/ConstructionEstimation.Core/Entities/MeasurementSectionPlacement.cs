namespace ConstructionEstimation.Core.Entities;

/// <summary>
/// One counted occurrence of a reusable measurement section. Coordinates are
/// stored as page ratios so markers stay attached to the same PDF position at
/// every zoom level and across pages with different rendered sizes.
/// </summary>
public class MeasurementSectionPlacement : BaseEntity
{
    public int MeasurementSectionId { get; set; }
    public MeasurementSection MeasurementSection { get; set; } = null!;

    public int DrawingId { get; set; }
    public Drawing Drawing { get; set; } = null!;
    public int PageNumber { get; set; } = 1;
    public double XRatio { get; set; }
    public double YRatio { get; set; }
    public bool IsSource { get; set; }
}
