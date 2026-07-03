namespace ConstructionEstimation.Core.DTOs;

public record ExtractedMemberDto(
    string Mark,
    string MemberSize,
    string MemberType,
    double UnitWeight,
    double Length,
    int Quantity,
    string Description,
    double Confidence,
    string? Color = null
);

public record ExtractionResultDto(
    int DrawingId,
    string DrawingName,
    int PageCount,
    int TotalExtracted,
    List<ExtractedMemberDto> Members,
    List<string> RawTextSample,
    string Status,
    string? ErrorMessage
);

public record BulkCreateMemberScheduleRequest(
    List<CreateMemberScheduleItemRequest> Items
);
