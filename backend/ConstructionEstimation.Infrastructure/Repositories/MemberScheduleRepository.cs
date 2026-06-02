using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MemberScheduleRepository : BaseRepository<MemberScheduleItem>, IMemberScheduleRepository
{
    public MemberScheduleRepository(AppDbContext context) : base(context) { }

    public async Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId)
    {
        return await _context.MemberScheduleItems
            .Where(m => m.DrawingId == drawingId)
            .OrderBy(m => m.Mark)
            .ToListAsync();
    }

    public async Task<bool> DeleteByDrawingIdAsync(int drawingId)
    {
        var items = await _context.MemberScheduleItems
            .Where(m => m.DrawingId == drawingId)
            .ToListAsync();

        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }
}
