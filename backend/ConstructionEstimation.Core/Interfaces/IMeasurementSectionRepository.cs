using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface IMeasurementSectionRepository : IRepository<MeasurementSection>
{
    Task<IReadOnlyList<MeasurementSection>> GetByProjectIdAsync(int projectId);
    Task<MeasurementSection?> GetWithPlacementsAsync(int id);
    Task<MeasurementSection?> FindByNameAsync(int projectId, string name);
    Task<MeasurementSectionPlacement> AddPlacementAsync(MeasurementSectionPlacement placement);
    Task<bool> DeletePlacementAsync(int sectionId, int placementId);
}
