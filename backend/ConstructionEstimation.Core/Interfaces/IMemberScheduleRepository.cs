using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface IMemberScheduleRepository : IRepository<MemberScheduleItem>
{
    Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId);
    Task<bool> DeleteByDrawingIdAsync(int drawingId);
}
