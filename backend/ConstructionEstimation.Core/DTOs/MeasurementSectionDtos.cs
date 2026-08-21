namespace ConstructionEstimation.Core.DTOs;

public record CreateMeasurementSectionRequest(
    string Name,
    string TemplateJson,
    int MeasurementCount,
    int SourceDrawingId,
    int SourcePageNumber,
    double SourceXRatio,
    double SourceYRatio,
    string? Color = null
);

public record UpdateMeasurementSectionRequest(string Name);

public record UpdateMeasurementSectionTemplateRequest(
    string Name,
    string TemplateJson,
    int MeasurementCount,
    int SourcePageNumber,
    double SourceXRatio,
    double SourceYRatio
);

public record CreateMeasurementSectionPlacementRequest(
    int DrawingId,
    int PageNumber,
    double XRatio,
    double YRatio
);

public record MeasurementSectionPlacementResponse(
    int Id,
    int DrawingId,
    int PageNumber,
    double XRatio,
    double YRatio,
    bool IsSource,
    DateTime CreatedAt
);

public record MeasurementSectionResponse(
    int Id,
    int ProjectId,
    string Name,
    string Color,
    string TemplateJson,
    int MeasurementCount,
    int SourceDrawingId,
    int SourcePageNumber,
    int UsedPlaces,
    IReadOnlyList<MeasurementSectionPlacementResponse> Placements,
    DateTime CreatedAt,
    DateTime UpdatedAt
);
