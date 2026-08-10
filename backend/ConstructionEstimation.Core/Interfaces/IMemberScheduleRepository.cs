using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface IMemberScheduleRepository : IRepository<MemberScheduleItem>
{
    Task<IEnumerable<MemberScheduleItem>> GetByProjectIdAsync(int projectId);
    Task<int> ConsolidateExactDuplicatesAsync(int projectId);
    Task<MemberScheduleItem?> GetByProjectAndMarkAsync(int projectId, string mark);
    Task<MemberScheduleItem?> GetByProjectMarkAndSectionAsync(
        int projectId,
        string mark,
        string memberSize);
    Task<bool> DeleteWithLinkedMeasurementsAsync(int id);
    Task<bool> DeleteByProjectIdAsync(int projectId);

    // Reading through a drawing remains project-wide for backward-compatible
    // shared-schedule display. Deletion is source-scoped so removing one
    // drawing cannot remove schedule rows contributed by another drawing.
    Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId);
    Task<bool> DeleteByDrawingIdAsync(int drawingId);
}
