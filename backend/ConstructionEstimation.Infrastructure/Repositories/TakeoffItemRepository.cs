using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class TakeoffItemRepository : BaseRepository<TakeoffItem>, ITakeoffItemRepository
{
    public TakeoffItemRepository(AppDbContext context) : base(context) { }

    public async Task<IEnumerable<TakeoffItem>> GetByDrawingIdAsync(int drawingId) =>
        await _dbSet
            .Where(t => t.DrawingId == drawingId)
            .OrderBy(t => t.CreatedAt)
            .ToListAsync();

    public async Task<bool> DeleteByDrawingIdAsync(int drawingId)
    {
        var items = await _dbSet.Where(t => t.DrawingId == drawingId).ToListAsync();
        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<TakeoffItem?> RestoreAsync(int id)
    {
        var item = await _dbSet
            .IgnoreQueryFilters()
            .FirstOrDefaultAsync(t => t.Id == id);

        if (item == null) return null;

        item.IsDeleted = false;
        await _context.SaveChangesAsync();
        return item;
    }
}
