using ConstructionEstimation.Core.DTOs;

namespace ConstructionEstimation.API.Services.Licensing;

public sealed record LicenseApiRequest(
    string LicenseKey,
    string? ApiKey,
    string ApiUrl,
    string ValidationUrl);

public interface ILicenseApiClient
{
    Task<LicenseValidationResult> ValidateAsync(
        LicenseApiRequest request,
        CancellationToken cancellationToken = default);
}
