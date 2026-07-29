using ConstructionEstimation.Core.DTOs;

namespace ConstructionEstimation.API.Services.Licensing;

public sealed record LicenseApiRequest(
    string LicenseKey,
    string? ApiKey,
    string ApiBaseUrl,
    string ValidationEndpoint,
    string ApplicationIdentifier,
    string MachineIdentifier,
    string? CustomerName,
    string? CompanyName);

public interface ILicenseApiClient
{
    Task<LicenseValidationResult> ValidateAsync(
        LicenseApiRequest request,
        CancellationToken cancellationToken = default);
}
