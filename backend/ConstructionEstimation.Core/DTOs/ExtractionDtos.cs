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

public record MarkDetectionPointDto(
    double X,
    double Y
);

public record DetectDrawingMarkRequest(
    int PageNumber,
    List<MarkDetectionPointDto> Points,
    List<string> KnownMarks
);

public record DetectDrawingMarkResponse(
    string Mark,
    string RawText
);
