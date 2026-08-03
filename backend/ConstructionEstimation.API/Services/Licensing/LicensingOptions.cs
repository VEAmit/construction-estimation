namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicensingOptions
{
    public const string SectionName = "Licensing";

    // Leave empty by default so IIS deployments do not persist a development-only
    // localhost URL. When omitted, LicenseService resolves the public URL from the
    // request that submits the first license configuration.
    public string ApplicationApiUrl { get; set; } = string.Empty;
    public string ValidationUrl { get; set; } =
        "http://subscription.integratedsteelsolutions.com/api/License/validateLicense";
    public string DefaultApplicationIdentifier { get; set; } = "BuildTakeoffPro";
    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";
    public int CacheMinutes { get; set; } = 30;
    public int FailureCacheMinutes { get; set; } = 2;
    public int HttpTimeoutSeconds { get; set; } = 15;
}
