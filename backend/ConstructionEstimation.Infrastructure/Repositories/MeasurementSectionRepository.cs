using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MeasurementSectionRepository : BaseRepository<MeasurementSection>, IMeasurementSectionRepository
{
    public MeasurementSectionRepository(AppDbContext context) : base(context) { }

    public async Task<IReadOnlyList<MeasurementSection>> GetByProjectIdAsync(int projectId)
    {
        await PurgeOrphanedSectionDataAsync(projectId);

        return await _dbSet
            .AsNoTracking()
            .Where(section => section.ProjectId == projectId)
            .Include(section => section.Placements.Where(placement => !placement.IsDeleted))
            .OrderBy(section => section.Name)
            .ToListAsync();
    }

    public async Task<MeasurementSection?> GetWithPlacementsAsync(int id) =>
        await _dbSet
            .Include(section => section.Placements.Where(placement => !placement.IsDeleted))
            .FirstOrDefaultAsync(section => section.Id == id);

    public async Task<MeasurementSection?> FindByNameAsync(int projectId, string name)
    {
        await PurgeOrphanedSectionDataAsync(projectId);

        var normalizedName = name.Trim();
        return await _dbSet.FirstOrDefaultAsync(section =>
            section.ProjectId == projectId && section.Name == normalizedName);
    }

    private async Task PurgeOrphanedSectionDataAsync(int projectId)
    {
        // The source PDF defines the lifetime of a section. Permanently purge
        // legacy rows whose source drawing is no longer active, plus counted
        // placements that point to deleted drawings. Ignore soft-delete filters
        // so data left by every previous build is removed from the database.
        var activeDrawingIds = (await _context.Drawings
                .Where(drawing => drawing.ProjectId == projectId)
                .Select(drawing => drawing.Id)
                .ToListAsync())
            .ToHashSet();
        var projectSections = await _context.MeasurementSections
            .IgnoreQueryFilters()
            .Where(section => section.ProjectId == projectId)
            .ToListAsync();
        if (projectSections.Count == 0) return;

        var projectSectionIds = projectSections.Select(section => section.Id).ToList();
        var orphanedSections = projectSections
            .Where(section => !activeDrawingIds.Contains(section.SourceDrawingId))
            .ToList();
        var orphanedSectionIds = orphanedSections.Select(section => section.Id).ToHashSet();
        var placementsToDelete = await _context.MeasurementSectionPlacements
            .IgnoreQueryFilters()
            .Where(placement => projectSectionIds.Contains(placement.MeasurementSectionId))
            .ToListAsync();
        placementsToDelete = placementsToDelete
            .Where(placement =>
                orphanedSectionIds.Contains(placement.MeasurementSectionId) ||
                !activeDrawingIds.Contains(placement.DrawingId))
            .ToList();

        if (placementsToDelete.Count == 0 && orphanedSections.Count == 0) return;

        _context.MeasurementSectionPlacements.RemoveRange(placementsToDelete);
        _context.MeasurementSections.RemoveRange(orphanedSections);
        await _context.SaveChangesAsync();
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
