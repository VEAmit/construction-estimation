namespace ConstructionEstimation.Core.Entities;

public class Drawing : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string FilePath { get; set; } = string.Empty;
    public long FileSizeBytes { get; set; }
    public int PageCount { get; set; } = 1;

    // Scale calibration: how many mm does 1 pixel represent
    public double ScaleRatio { get; set; } = 1.0;
    public bool IsCalibrated { get; set; } = false;
    public string CalibrationUnit { get; set; } = "mm";

    // Stores the full Syncfusion annotation export blob (base64 string) so drawn lines
    // can be re-imported after a page refresh without any format reconstruction.
    public string? AnnotationData { get; set; }

    public int ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public ICollection<TakeoffItem> TakeoffItems { get; set; } = new List<TakeoffItem>();
    public ICollection<MemberScheduleItem> MemberScheduleItems { get; set; } = new List<MemberScheduleItem>();
}
