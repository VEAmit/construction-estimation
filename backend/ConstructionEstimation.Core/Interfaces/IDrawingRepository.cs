using ConstructionEstimation.Core.Entities;

namespace ConstructionEstimation.Core.Interfaces;

public interface IDrawingRepository : IRepository<Drawing>
{
    Task<IEnumerable<Drawing>> GetByProjectIdAsync(int projectId);
    Task<Drawing?> GetWithTakeoffItemsAsync(int drawingId);
    Task<bool> UpdateScaleAsync(int drawingId, double scaleRatio, string unit);
    Task<bool> ResetCalibrationAsync(int drawingId);
    Task<bool> UpdateAnnotationsAsync(int drawingId, string annotationData);
}
