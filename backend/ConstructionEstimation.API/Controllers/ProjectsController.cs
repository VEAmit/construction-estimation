using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;

namespace ConstructionEstimation.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class ProjectsController : ControllerBase
{
    private readonly IProjectRepository _projectRepo;

    public ProjectsController(IProjectRepository projectRepo) => _projectRepo = projectRepo;

    private int GetUserId() =>
        int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    [HttpGet]
    public async Task<ActionResult<ApiResponse<IEnumerable<ProjectResponse>>>> GetAll()
    {
        var projects = await _projectRepo.GetByUserIdAsync(GetUserId());
        var response = projects.Select(p => new ProjectResponse(
            p.Id, p.Name, p.ProjectNumber, p.Description, p.ClientName, p.Location,
            p.Status.ToString(), p.Drawings.Count, p.CreatedAt
        ));
        return Ok(ApiResponse<IEnumerable<ProjectResponse>>.Ok(response));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<ProjectResponse>>> GetById(int id)
    {
        var project = await _projectRepo.GetWithDrawingsAsync(id);
        if (project == null || project.UserId != GetUserId())
            return NotFound(ApiResponse<ProjectResponse>.Fail("Project not found"));

        return Ok(ApiResponse<ProjectResponse>.Ok(new ProjectResponse(
            project.Id, project.Name, project.ProjectNumber, project.Description, project.ClientName,
            project.Location, project.Status.ToString(), project.Drawings.Count, project.CreatedAt
        )));
    }

    [HttpPost]
    public async Task<ActionResult<ApiResponse<ProjectResponse>>> Create([FromBody] CreateProjectRequest request)
    {
        var project = new Project
        {
            Name = request.Name,
            ProjectNumber = request.ProjectNumber ?? string.Empty,
            Description = request.Description ?? string.Empty,
            ClientName = request.ClientName ?? string.Empty,
            Location = request.Location ?? string.Empty,
            UserId = GetUserId()
        };

        await _projectRepo.AddAsync(project);
        return Ok(ApiResponse<ProjectResponse>.Ok(new ProjectResponse(
            project.Id, project.Name, project.ProjectNumber, project.Description, project.ClientName,
            project.Location, project.Status.ToString(), 0, project.CreatedAt
        ), "Project created successfully"));
    }

    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse<ProjectResponse>>> Update(int id, [FromBody] UpdateProjectRequest request)
    {
        var project = await _projectRepo.GetByIdAsync(id);
        if (project == null || project.UserId != GetUserId())
            return NotFound(ApiResponse<ProjectResponse>.Fail("Project not found"));

        project.Name = request.Name;
        project.ProjectNumber = request.ProjectNumber ?? string.Empty;
        project.Description = request.Description ?? string.Empty;
        project.ClientName = request.ClientName ?? string.Empty;
        project.Location = request.Location ?? string.Empty;
        project.Status = Enum.Parse<ProjectStatus>(request.Status);
        await _projectRepo.UpdateAsync(project);

        return Ok(ApiResponse<ProjectResponse>.Ok(new ProjectResponse(
            project.Id, project.Name, project.ProjectNumber, project.Description, project.ClientName,
            project.Location, project.Status.ToString(), 0, project.CreatedAt
        ), "Project updated"));
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        var project = await _projectRepo.GetByIdAsync(id);
        if (project == null || project.UserId != GetUserId())
            return NotFound(ApiResponse<bool>.Fail("Project not found"));

        await _projectRepo.DeleteAsync(id);
        return Ok(ApiResponse<bool>.Ok(true, "Project deleted"));
    }
}
