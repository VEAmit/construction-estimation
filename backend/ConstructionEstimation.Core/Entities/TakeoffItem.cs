namespace ConstructionEstimation.Core.Entities;

public class TakeoffItem : BaseEntity
{
    public string Mark { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public ItemType ItemType { get; set; } = ItemType.Line;

    // Measurement values
    public double? Length { get; set; }
    public double? Area { get; set; }
    public int Quantity { get; set; } = 1;
    public MeasurementUnit Unit { get; set; } = MeasurementUnit.Mm;

    // Steel specific
    public string Material { get; set; } = "Steel";
    public double? UnitWeight { get; set; }   // kg/m
    public double? TotalWeight { get; set; }  // kg

    public string Notes { get; set; } = string.Empty;

    // Serialized canvas points for the measurement shape
    public string? PointsJson { get; set; }

    // Color/category for multi-color measurement workflow
    public string? Color { get; set; }
    public string? Category { get; set; }

    // Snapshot of the drawing's calibration at the moment this item was created —
    // never rewritten by a later recalibration, so Length/Area always reflect the
    // scale that was active when the measurement was drawn.
    public double? ScaleRatioAtCreation { get; set; }
    public string? CalibrationUnitAtCreation { get; set; }

    public int DrawingId { get; set; }
    public Drawing Drawing { get; set; } = null!;
}

public enum ItemType
{
    Line,
    Area,
    Rectangle,
    Count
}

public enum MeasurementUnit
{
    Mm,
    Cm,
    Meter,
    Feet,
    Inch
}
