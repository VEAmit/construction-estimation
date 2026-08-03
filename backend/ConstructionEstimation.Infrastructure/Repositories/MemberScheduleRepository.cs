using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MemberScheduleRepository : BaseRepository<MemberScheduleItem>, IMemberScheduleRepository
{
    public MemberScheduleRepository(AppDbContext context) : base(context) { }

    public async Task<IEnumerable<MemberScheduleItem>> GetByProjectIdAsync(int projectId)
    {
        return await _context.MemberScheduleItems
            .Where(m => m.ProjectId == projectId)
            .OrderBy(m => m.Mark)
            .ToListAsync();
    }

    public async Task<MemberScheduleItem?> GetByProjectAndMarkAsync(int projectId, string mark)
    {
        var normalizedMark = mark.Trim().ToUpper();
        return await _context.MemberScheduleItems
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
        var projectId = await _context.Drawings
            .Where(d => d.Id == drawingId)
            .Select(d => (int?)d.ProjectId)
            .FirstOrDefaultAsync();

        return projectId.HasValue && await DeleteByProjectIdAsync(projectId.Value);
    }
}
