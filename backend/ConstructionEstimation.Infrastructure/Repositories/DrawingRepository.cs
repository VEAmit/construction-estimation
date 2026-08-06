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
        // triggered. Soft-delete only schedule rows extracted from this
        // drawing in the same SaveChanges call. Project-created rows have a
        // null DrawingId, and rows from every other drawing remain untouched.
        var sourcedScheduleItems = await _context.MemberScheduleItems
            .Where(item => item.DrawingId == id)
            .ToListAsync();

        drawing.IsDeleted = true;
        foreach (var item in sourcedScheduleItems)
            item.IsDeleted = true;

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
