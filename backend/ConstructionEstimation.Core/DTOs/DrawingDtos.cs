namespace ConstructionEstimation.Core.DTOs;

public record DrawingResponse(
    int Id,
    string Name,
    string FileName,
    long FileSizeBytes,
    int PageCount,
    double ScaleRatio,
    bool IsCalibrated,
    string CalibrationUnit,
    int ProjectId,
    int TakeoffItemCount,
    DateTime CreatedAt,
    string? AnnotationData
);

public record CalibrateRequest(
    double ScaleRatio,
    string Unit
);

public record SaveAnnotationsRequest(
    string AnnotationData
);
