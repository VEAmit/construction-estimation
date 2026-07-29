namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicensingOptions
{
    public const string SectionName = "Licensing";

    public string DefaultValidationEndpoint { get; set; } = "api/license/validate";
    public string DefaultApplicationIdentifier { get; set; } = "BuildTakeoffPro";
    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";
    public int CacheMinutes { get; set; } = 30;
    public int FailureCacheMinutes { get; set; } = 2;
    public int HttpTimeoutSeconds { get; set; } = 15;
}
