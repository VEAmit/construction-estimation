namespace ConstructionEstimation.Core.DTOs;

public record CreateProjectRequest(
    string Name,
    string ProjectNumber,
    string Description,
    string ClientName,
    string Location
);

public record UpdateProjectRequest(
    string Name,
    string ProjectNumber,
    string Description,
    string ClientName,
    string Location,
    string Status
);

public record ProjectResponse(
    int Id,
    string Name,
    string ProjectNumber,
    string Description,
    string ClientName,
    string Location,
    string Status,
    int DrawingCount,
    DateTime CreatedAt
);
