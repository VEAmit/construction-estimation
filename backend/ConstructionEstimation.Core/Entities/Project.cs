namespace ConstructionEstimation.Core.Entities;

public class Project : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string ProjectNumber { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string ClientName { get; set; } = string.Empty;
    public string Location { get; set; } = string.Empty;
    public ProjectStatus Status { get; set; } = ProjectStatus.Active;

    public int UserId { get; set; }
    public User User { get; set; } = null!;
    public ICollection<Drawing> Drawings { get; set; } = new List<Drawing>();
}

public enum ProjectStatus
{
    Active,
    Completed,
    OnHold,
    Cancelled
}
