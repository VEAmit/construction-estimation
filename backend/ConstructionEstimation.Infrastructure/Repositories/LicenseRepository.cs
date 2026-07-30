using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public sealed class LicenseRepository : ILicenseRepository
{
    private readonly AppDbContext _context;

    public LicenseRepository(AppDbContext context)
    {
        _context = context;
    }

    public Task<LicenseConfiguration?> GetActiveAsync(CancellationToken cancellationToken = default) =>
        _context.LicenseConfigurations
            .FirstOrDefaultAsync(configuration => configuration.IsActive, cancellationToken);

    public async Task<LicenseConfiguration> SaveAsync(
        LicenseConfiguration configuration,
        CancellationToken cancellationToken = default)
    {
        if (configuration.Id == 0)
            await _context.LicenseConfigurations.AddAsync(configuration, cancellationToken);
        else
            _context.LicenseConfigurations.Update(configuration);

        await _context.SaveChangesAsync(cancellationToken);
        return configuration;
    }
}
