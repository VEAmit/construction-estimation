using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class DrawingRepository : BaseRepository<Drawing>, IDrawingRepository
{
    public DrawingRepository(AppDbContext context) : base(context) { }

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
