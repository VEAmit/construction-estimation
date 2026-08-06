using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MemberScheduleRepository : BaseRepository<MemberScheduleItem>, IMemberScheduleRepository
{
    public MemberScheduleRepository(AppDbContext context) : base(context) { }

    private IQueryable<MemberScheduleItem> WithActiveSourceDrawing() =>
        _context.MemberScheduleItems.Where(item =>
            item.DrawingId == null ||
            _context.Drawings.Any(drawing => drawing.Id == item.DrawingId.Value));

    public async Task<IEnumerable<MemberScheduleItem>> GetByProjectIdAsync(int projectId)
    {
        // Older builds could soft-delete a drawing without soft-deleting the
        // schedule rows extracted from it. The Drawings query filter makes the
        // Any() check consider active drawings only, so those legacy orphaned
        // rows disappear immediately while project-created (DrawingId = null)
        // and other active drawings' rows remain available.
        return await WithActiveSourceDrawing()
            .Where(m => m.ProjectId == projectId)
            .OrderBy(m => m.Mark)
            .ToListAsync();
    }

    public async Task<MemberScheduleItem?> GetByProjectAndMarkAsync(int projectId, string mark)
    {
        var normalizedMark = mark.Trim().ToUpper();
        return await WithActiveSourceDrawing()
            .FirstOrDefaultAsync(m =>
                m.ProjectId == projectId &&
                m.Mark.Trim().ToUpper() == normalizedMark);
    }

    public async Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId)
    {
        var projectId = await _context.Drawings
            .Where(d => d.Id == drawingId)
            .Select(d => (int?)d.ProjectId)
            .FirstOrDefaultAsync();

        return projectId.HasValue
            ? await GetByProjectIdAsync(projectId.Value)
            : [];
    }

    public async Task<bool> DeleteByProjectIdAsync(int projectId)
    {
        var items = await _context.MemberScheduleItems
            .Where(m => m.ProjectId == projectId)
            .ToListAsync();

        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<bool> DeleteByDrawingIdAsync(int drawingId)
    {
        var items = await _context.MemberScheduleItems
            .Where(item => item.DrawingId == drawingId)
            .ToListAsync();

        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }
}
