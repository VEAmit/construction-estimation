using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface IMemberScheduleRepository : IRepository<MemberScheduleItem>
{
    Task<IEnumerable<MemberScheduleItem>> GetByProjectIdAsync(int projectId);
    Task<MemberScheduleItem?> GetByProjectAndMarkAsync(int projectId, string mark);
    Task<bool> DeleteByProjectIdAsync(int projectId);

    // Backward-compatible drawing operations resolve the drawing's project and
    // operate on its shared schedule.
    Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId);
    Task<bool> DeleteByDrawingIdAsync(int drawingId);
}
