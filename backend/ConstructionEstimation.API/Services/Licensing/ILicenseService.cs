using ConstructionEstimation.Core.DTOs;

namespace ConstructionEstimation.API.Services.Licensing;

public interface ILicenseService
{
    Task EnsureServerConfigurationAsync(
        CancellationToken cancellationToken = default);

    Task<LicenseConfigurationStatusDto> GetConfigurationStatusAsync(
        CancellationToken cancellationToken = default);

    Task<LicenseValidationResult> ValidateCurrentAsync(
        bool forceRefresh,
        string source,
        CancellationToken cancellationToken = default);

    Task<LicenseValidationResult> ValidateAndSaveAsync(
        LicenseConfigurationRequest request,
        CancellationToken cancellationToken = default);

    void InvalidateCache();
}
