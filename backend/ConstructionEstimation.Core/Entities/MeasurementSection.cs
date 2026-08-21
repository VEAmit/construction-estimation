namespace ConstructionEstimation.Core.Entities;

/// <summary>
/// A reusable, project-level snapshot of a set of measurements.  The template
/// is deliberately stored separately from TakeoffItems so creating or using a
/// section never merges, duplicates, or mutates the measurement grid rows.
/// </summary>
public class MeasurementSection : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string Color { get; set; } = "#3B82F6";
    public string TemplateJson { get; set; } = "{}";
    public int MeasurementCount { get; set; }
    public int SourceDrawingId { get; set; }
    public int SourcePageNumber { get; set; } = 1;

    public int ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public ICollection<MeasurementSectionPlacement> Placements { get; set; }
        = new List<MeasurementSectionPlacement>();
}
