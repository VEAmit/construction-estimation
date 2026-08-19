using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class DrawingRepository : BaseRepository<Drawing>, IDrawingRepository
{
    public DrawingRepository(AppDbContext context) : base(context) { }

    public override async Task<bool> DeleteAsync(int id)
    {
        var drawing = await GetByIdAsync(id);
        if (drawing == null) return false;

        // Drawings use soft deletion, so the database FK cascade is never
        // triggered. While other drawings remain, remove only schedule rows
        // sourced from this drawing. When this is the project's last active
        // drawing, remove the complete shared schedule as well: consolidated
        // and manually-created project rows intentionally have DrawingId =
        // null and would otherwise remain as orphaned members.
        var hasOtherActiveDrawings = await _context.Drawings.AnyAsync(item =>
            item.ProjectId == drawing.ProjectId && item.Id != drawing.Id);
        var scheduleItemsToDelete = await _context.MemberScheduleItems
            .Where(item => item.ProjectId == drawing.ProjectId &&
                (!hasOtherActiveDrawings || item.DrawingId == id))
            .ToListAsync();

        // Section groups cannot exist without their source PDF. Unlike the
        // drawing itself, permanently remove these dependent records instead
        // of soft-deleting them. This prevents an old group from reappearing
        // after another PDF is uploaded to the same project. Ignore query
        // filters so records left by older builds are cleaned at the same time.
        var sectionsToDelete = await _context.MeasurementSections
            .IgnoreQueryFilters()
            .Where(section => section.ProjectId == drawing.ProjectId &&
                (!hasOtherActiveDrawings || section.SourceDrawingId == id))
            .ToListAsync();
        var sectionIdsToDelete = sectionsToDelete.Select(section => section.Id).ToList();
        var sectionPlacementsToDelete = await _context.MeasurementSectionPlacements
            .IgnoreQueryFilters()
            .Where(placement => placement.DrawingId == id ||
                sectionIdsToDelete.Contains(placement.MeasurementSectionId))
            .ToListAsync();

        drawing.IsDeleted = true;
        foreach (var item in scheduleItemsToDelete)
            item.IsDeleted = true;
        _context.MeasurementSectionPlacements.RemoveRange(sectionPlacementsToDelete);
        _context.MeasurementSections.RemoveRange(sectionsToDelete);

        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<IEnumerable<Drawing>> GetByProjectIdAsync(int projectId) =>
        await _dbSet
            .Include(d => d.TakeoffItems)
            .Where(d => d.ProjectId == projectId)
            .OrderByDescending(d => d.CreatedAt)
            .ToListAsync();

    public async Task<Drawing?> GetWithTakeoffItemsAsync(int drawingId) =>
        await _dbSet
            .Include(d => d.TakeoffItems.Where(t => !t.IsDeleted))
            .FirstOrDefaultAsync(d => d.Id == drawingId);

    public async Task<bool> IsFilePathReferencedByAnotherDrawingAsync(
        string filePath,
        int drawingId) =>
        await _dbSet.AnyAsync(d =>
            d.Id != drawingId &&
            d.FilePath == filePath);

    public async Task<bool> UpdateScaleAsync(int drawingId, double scaleRatio, string unit)
    {
        if (scaleRatio <= 0 || string.IsNullOrWhiteSpace(unit))
            return false;

        var drawing = await GetByIdAsync(drawingId);
        if (drawing == null) return false;

        drawing.ScaleRatio = scaleRatio;
        drawing.CalibrationUnit = unit;
        drawing.IsCalibrated = true;
        drawing.UpdatedAt = DateTime.UtcNow;
        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<bool> ResetCalibrationAsync(int drawingId)
    {
        var drawing = await GetByIdAsync(drawingId);
        if (drawing == null) return false;
        drawing.IsCalibrated = false;
        drawing.ScaleRatio   = 0;
        drawing.UpdatedAt    = DateTime.UtcNow;
        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<bool> UpdateAnnotationsAsync(int drawingId, string annotationData)
    {
        var drawing = await GetByIdAsync(drawingId);
        if (drawing == null) return false;

        drawing.AnnotationData = annotationData;
        drawing.UpdatedAt = DateTime.UtcNow;
        await _context.SaveChangesAsync();
        return true;
    }
}
