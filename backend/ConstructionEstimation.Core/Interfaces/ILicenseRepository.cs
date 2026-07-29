using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface ILicenseRepository
{
    Task<LicenseConfiguration?> GetActiveAsync(CancellationToken cancellationToken = default);
    Task<LicenseConfiguration> SaveAsync(
        LicenseConfiguration configuration,
        CancellationToken cancellationToken = default);
}
