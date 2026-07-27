using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface ITakeoffItemRepository : IRepository<TakeoffItem>
{
    Task<IEnumerable<TakeoffItem>> GetByDrawingIdAsync(int drawingId);
    Task<bool> DeleteByDrawingIdAsync(int drawingId);
    Task<TakeoffItem?> RestoreAsync(int id);
}
