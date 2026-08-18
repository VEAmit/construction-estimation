using System.Text.Json;
using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ConstructionEstimation.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class MeasurementSectionsController : ControllerBase
{
    private readonly IMeasurementSectionRepository _sections;
    private readonly IProjectRepository _projects;
    private readonly IDrawingRepository _drawings;

    public MeasurementSectionsController(
        IMeasurementSectionRepository sections,
        IProjectRepository projects,
        IDrawingRepository drawings)
    {
        _sections = sections;
        _projects = projects;
        _drawings = drawings;
    }

    [HttpGet("project/{projectId:int}")]
    public async Task<ActionResult<ApiResponse<IReadOnlyList<MeasurementSectionResponse>>>> GetByProject(
        int projectId)
    {
        if (!await _projects.ExistsAsync(projectId))
            return NotFound(ApiResponse<IReadOnlyList<MeasurementSectionResponse>>.Fail("Project not found"));

        var sections = await _sections.GetByProjectIdAsync(projectId);
        return Ok(ApiResponse<IReadOnlyList<MeasurementSectionResponse>>.Ok(
            sections.Select(Map).ToList()));
    }

    [HttpPost("project/{projectId:int}")]
    public async Task<ActionResult<ApiResponse<MeasurementSectionResponse>>> Create(
        int projectId,
        [FromBody] CreateMeasurementSectionRequest request)
    {
        if (!await _projects.ExistsAsync(projectId))
            return NotFound(ApiResponse<MeasurementSectionResponse>.Fail("Project not found"));

        var name = (request.Name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section name is required"));
        if (name.Length > 200)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section name cannot exceed 200 characters"));
        if (request.MeasurementCount < 1)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Select at least one measurement"));
        if (!IsValidTemplate(request.TemplateJson))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section measurement template is invalid"));
        if (!IsRatio(request.SourceXRatio) || !IsRatio(request.SourceYRatio))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section position is invalid"));

        var sourceDrawing = await _drawings.GetByIdAsync(request.SourceDrawingId);
        if (sourceDrawing == null || sourceDrawing.ProjectId != projectId)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail(
                "The source drawing does not belong to this project"));
        if (await _sections.FindByNameAsync(projectId, name) != null)
            return Conflict(ApiResponse<MeasurementSectionResponse>.Fail(
                $"A section named '{name}' already exists in this project"));

        var section = new MeasurementSection
        {
            ProjectId = projectId,
            Name = name,
            TemplateJson = request.TemplateJson,
            MeasurementCount = request.MeasurementCount,
            SourceDrawingId = request.SourceDrawingId,
            SourcePageNumber = Math.Max(1, request.SourcePageNumber),
            Placements = new List<MeasurementSectionPlacement>
            {
                new()
                {
                    DrawingId = request.SourceDrawingId,
                    PageNumber = Math.Max(1, request.SourcePageNumber),
                    XRatio = request.SourceXRatio,
                    YRatio = request.SourceYRatio,
                    IsSource = true,
                },
            },
        };

        await _sections.AddAsync(section);
        var saved = await _sections.GetWithPlacementsAsync(section.Id) ?? section;
        return Ok(ApiResponse<MeasurementSectionResponse>.Ok(
            Map(saved), "Measurement section created"));
    }

    [HttpPut("{id:int}")]
    public async Task<ActionResult<ApiResponse<MeasurementSectionResponse>>> Rename(
        int id,
        [FromBody] UpdateMeasurementSectionRequest request)
    {
        var section = await _sections.GetWithPlacementsAsync(id);
        if (section == null)
            return NotFound(ApiResponse<MeasurementSectionResponse>.Fail("Measurement section not found"));

        var name = (request.Name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Enter a valid section name"));
        var duplicate = await _sections.FindByNameAsync(section.ProjectId, name);
        if (duplicate != null && duplicate.Id != section.Id)
            return Conflict(ApiResponse<MeasurementSectionResponse>.Fail(
                $"A section named '{name}' already exists in this project"));

        section.Name = name;
        await _sections.UpdateAsync(section);
        return Ok(ApiResponse<MeasurementSectionResponse>.Ok(Map(section), "Section renamed"));
    }

    [HttpPost("{id:int}/placements")]
    public async Task<ActionResult<ApiResponse<MeasurementSectionResponse>>> AddPlacement(
        int id,
        [FromBody] CreateMeasurementSectionPlacementRequest request)
    {
        var section = await _sections.GetWithPlacementsAsync(id);
        if (section == null)
            return NotFound(ApiResponse<MeasurementSectionResponse>.Fail("Measurement section not found"));
        if (!IsRatio(request.XRatio) || !IsRatio(request.YRatio))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section position is invalid"));

        var drawing = await _drawings.GetByIdAsync(request.DrawingId);
        if (drawing == null || drawing.ProjectId != section.ProjectId)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail(
                "The selected drawing does not belong to this section's project"));

        var placement = new MeasurementSectionPlacement
        {
            MeasurementSectionId = section.Id,
            DrawingId = request.DrawingId,
            PageNumber = Math.Max(1, request.PageNumber),
            XRatio = request.XRatio,
            YRatio = request.YRatio,
            IsSource = false,
        };
        await _sections.AddPlacementAsync(placement);
        return Ok(ApiResponse<MeasurementSectionResponse>.Ok(
            Map(section), $"{section.Name} counted at {section.Placements.Count(p => !p.IsDeleted)} places"));
    }

    [HttpPut("{id:int}/template")]
    public async Task<ActionResult<ApiResponse<MeasurementSectionResponse>>> UpdateTemplate(
        int id,
        [FromBody] UpdateMeasurementSectionTemplateRequest request)
    {
        var section = await _sections.GetWithPlacementsAsync(id);
        if (section == null)
            return NotFound(ApiResponse<MeasurementSectionResponse>.Fail("Measurement section not found"));

        var name = (request.Name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Enter a valid section name"));
        if (request.MeasurementCount < 1)
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail(
                "The resized section must contain at least one measurement"));
        if (!IsValidTemplate(request.TemplateJson))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section measurement template is invalid"));
        if (!IsRatio(request.SourceXRatio) || !IsRatio(request.SourceYRatio))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail("Section position is invalid"));

        var duplicate = await _sections.FindByNameAsync(section.ProjectId, name);
        if (duplicate != null && duplicate.Id != section.Id)
            return Conflict(ApiResponse<MeasurementSectionResponse>.Fail(
                $"A section named '{name}' already exists in this project"));

        section.Name = name;
        section.TemplateJson = request.TemplateJson;
        section.MeasurementCount = request.MeasurementCount;
        section.SourcePageNumber = Math.Max(1, request.SourcePageNumber);

        var sourcePlacement = section.Placements.FirstOrDefault(placement => placement.IsSource);
        if (sourcePlacement == null)
        {
            sourcePlacement = new MeasurementSectionPlacement
            {
                DrawingId = section.SourceDrawingId,
                IsSource = true,
            };
            section.Placements.Add(sourcePlacement);
        }
        sourcePlacement.PageNumber = section.SourcePageNumber;
        sourcePlacement.XRatio = request.SourceXRatio;
        sourcePlacement.YRatio = request.SourceYRatio;

        await _sections.UpdateAsync(section);
        var saved = await _sections.GetWithPlacementsAsync(section.Id) ?? section;
        return Ok(ApiResponse<MeasurementSectionResponse>.Ok(
            Map(saved), "Measurement section updated"));
    }

    [HttpDelete("{id:int}/placements/{placementId:int}")]
    [HttpPost("{id:int}/placements/{placementId:int}/delete")]
    public async Task<ActionResult<ApiResponse<MeasurementSectionResponse>>> DeletePlacement(
        int id,
        int placementId)
    {
        if (!await _sections.DeletePlacementAsync(id, placementId))
            return BadRequest(ApiResponse<MeasurementSectionResponse>.Fail(
                "The source location cannot be removed, or the placement was not found"));
        var section = await _sections.GetWithPlacementsAsync(id);
        if (section == null)
            return NotFound(ApiResponse<MeasurementSectionResponse>.Fail("Measurement section not found"));
        return Ok(ApiResponse<MeasurementSectionResponse>.Ok(Map(section), "Section placement removed"));
    }

    [HttpDelete("{id:int}")]
    [HttpPost("{id:int}/delete")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        if (!await _sections.DeleteAsync(id))
            return NotFound(ApiResponse<bool>.Fail("Measurement section not found"));
        return Ok(ApiResponse<bool>.Ok(true, "Measurement section deleted"));
    }

    private static bool IsValidTemplate(string? templateJson)
    {
        if (string.IsNullOrWhiteSpace(templateJson)) return false;
        try
        {
            using var document = JsonDocument.Parse(templateJson);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsRatio(double value) =>
        double.IsFinite(value) && value >= 0 && value <= 1;

    private static MeasurementSectionResponse Map(MeasurementSection section)
    {
        var placements = section.Placements
            .Where(placement => !placement.IsDeleted)
            .OrderBy(placement => placement.CreatedAt)
            .Select(placement => new MeasurementSectionPlacementResponse(
                placement.Id,
                placement.DrawingId,
                placement.PageNumber,
                placement.XRatio,
                placement.YRatio,
                placement.IsSource,
                placement.CreatedAt))
            .ToList();

        return new MeasurementSectionResponse(
            section.Id,
            section.ProjectId,
            section.Name,
            section.TemplateJson,
            section.MeasurementCount,
            section.SourceDrawingId,
            section.SourcePageNumber,
            placements.Count,
            placements,
            section.CreatedAt,
            section.UpdatedAt);
    }
}
