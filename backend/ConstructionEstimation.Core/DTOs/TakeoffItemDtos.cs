namespace ConstructionEstimation.Core.DTOs;

public record CreateTakeoffItemRequest(
    string Mark,
    string Description,
    string ItemType,
    double? Length,
    double? Area,
    int Quantity,
    string Unit,
    string Material,
    double? UnitWeight,
    string Notes,
    string? PointsJson,
    string? Color,
    string? Category
);

public record UpdateTakeoffItemRequest(
    string Mark,
    string Description,
    double? Length,
    double? Area,
    int Quantity,
    string Unit,
    string Material,
    double? UnitWeight,
    string Notes,
    string? Color,
    string? Category
);

public record TakeoffItemResponse(
    int Id,
    string Mark,
    string Description,
    string ItemType,
    double? Length,
    double? Area,
    int Quantity,
    string Unit,
    string Material,
    double? UnitWeight,
    double? TotalWeight,
    string Notes,
    string? PointsJson,
    int DrawingId,
    DateTime CreatedAt,
    string? Color,
    string? Category
);

public record TakeoffSummaryResponse(
    double TotalLength,
    double TotalArea,
    double TotalWeight,
    int TotalItems
);
