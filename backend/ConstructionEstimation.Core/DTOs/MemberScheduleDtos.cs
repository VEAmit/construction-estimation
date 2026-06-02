namespace ConstructionEstimation.Core.DTOs;

public record CreateMemberScheduleItemRequest(
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    string Description,
    int? TakeoffItemId
);

public record UpdateMemberScheduleItemRequest(
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    string Description,
    int? TakeoffItemId
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
    int DrawingId,
    DateTime CreatedAt
);

public record MemberScheduleSummaryResponse(
    int TotalMembers,
    int TotalQuantity,
    double TotalWeight
);
