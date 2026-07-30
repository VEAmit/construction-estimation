namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicensingOptions
{
    public const string SectionName = "Licensing";

    public string ApplicationApiUrl { get; set; } = "http://localhost:5000";
    public string ValidationUrl { get; set; } =
        "http://subscription.integratedsteelsolutions.com/api/License/validateLicense";
    public string DefaultApplicationIdentifier { get; set; } = "BuildTakeoffPro";
    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";
    public int CacheMinutes { get; set; } = 30;
    public int FailureCacheMinutes { get; set; } = 2;
    public int HttpTimeoutSeconds { get; set; } = 15;
}
