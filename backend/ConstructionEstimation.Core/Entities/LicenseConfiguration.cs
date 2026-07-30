namespace ConstructionEstimation.Core.Entities;

public sealed class LicenseConfiguration : BaseEntity
{
    public string EncryptedLicenseKey { get; set; } = string.Empty;
    public string? EncryptedApiKey { get; set; }
    public string ApiBaseUrl { get; set; } = string.Empty;
    public string ValidationEndpoint { get; set; } = string.Empty;
    public string ApplicationIdentifier { get; set; } = string.Empty;
    public string? MachineIdentifier { get; set; }
    public string? CustomerName { get; set; }
    public string? CompanyName { get; set; }
    public bool IsActive { get; set; } = true;
    public string LastValidationStatus { get; set; } = "Unverified";
    public DateTime? LastValidatedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}
