using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MeasurementSectionRepository : BaseRepository<MeasurementSection>, IMeasurementSectionRepository
{
    public MeasurementSectionRepository(AppDbContext context) : base(context) { }

    public async Task<IReadOnlyList<MeasurementSection>> GetByProjectIdAsync(int projectId) =>
        await _dbSet
            .AsNoTracking()
            .Where(section => section.ProjectId == projectId)
            .Include(section => section.Placements.Where(placement => !placement.IsDeleted))
            .OrderBy(section => section.Name)
            .ToListAsync();

    public async Task<MeasurementSection?> GetWithPlacementsAsync(int id) =>
        await _dbSet
            .Include(section => section.Placements.Where(placement => !placement.IsDeleted))
            .FirstOrDefaultAsync(section => section.Id == id);

    public async Task<MeasurementSection?> FindByNameAsync(int projectId, string name)
    {
        var normalizedName = name.Trim();
        return await _dbSet.FirstOrDefaultAsync(section =>
            section.ProjectId == projectId && section.Name == normalizedName);
    }

    public async Task<MeasurementSectionPlacement> AddPlacementAsync(MeasurementSectionPlacement placement)
    {
        await _context.MeasurementSectionPlacements.AddAsync(placement);
        await _context.SaveChangesAsync();
        return placement;
    }

    public async Task<bool> DeletePlacementAsync(int sectionId, int placementId)
    {
        var placement = await _context.MeasurementSectionPlacements
            .FirstOrDefaultAsync(item => item.Id == placementId
                && item.MeasurementSectionId == sectionId);
        if (placement == null || placement.IsSource) return false;
        placement.IsDeleted = true;
        await _context.SaveChangesAsync();
        return true;
    }
}
