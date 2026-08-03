namespace ConstructionEstimation.Core.DTOs;

public record CreateMemberScheduleItemRequest(
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    string Description,
    int? TakeoffItemId,
    string? Color = null
);

public record UpdateMemberScheduleItemRequest(
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    string Description,
    int? TakeoffItemId,
    string? Color = null
);

public record MemberScheduleItemResponse(
    int Id,
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    double TotalWeight,
    string Description,
    int? TakeoffItemId,
    int ProjectId,
    int? DrawingId,
    DateTime CreatedAt,
    string? Color
);

public record MemberScheduleSummaryResponse(
    int TotalMembers,
    int TotalQuantity,
    double TotalWeight
);
