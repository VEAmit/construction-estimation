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
public class MemberSchedulesController : ControllerBase
{
    private readonly IMemberScheduleRepository _repo;
    private readonly IDrawingRepository _drawingRepo;
    private readonly IProjectRepository _projectRepo;

    public MemberSchedulesController(
        IMemberScheduleRepository repo,
        IDrawingRepository drawingRepo,
        IProjectRepository projectRepo)
    {
        _repo = repo;
        _drawingRepo = drawingRepo;
        _projectRepo = projectRepo;
    }

    [HttpGet("project/{projectId}")]
    public async Task<ActionResult<ApiResponse<IEnumerable<MemberScheduleItemResponse>>>> GetByProject(int projectId)
    {
        if (!await _projectRepo.ExistsAsync(projectId))
            return NotFound(ApiResponse<IEnumerable<MemberScheduleItemResponse>>.Fail("Project not found"));

        var items = await _repo.GetByProjectIdAsync(projectId);
        return Ok(ApiResponse<IEnumerable<MemberScheduleItemResponse>>.Ok(items.Select(MapToResponse)));
    }

    // Kept for older clients. A drawing now resolves to its project's shared schedule.
    [HttpGet("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<IEnumerable<MemberScheduleItemResponse>>>> GetByDrawing(int drawingId)
    {
        var drawing = await _drawingRepo.GetByIdAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<IEnumerable<MemberScheduleItemResponse>>.Fail("Drawing not found"));

        var items = await _repo.GetByProjectIdAsync(drawing.ProjectId);
        return Ok(ApiResponse<IEnumerable<MemberScheduleItemResponse>>.Ok(items.Select(MapToResponse)));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> GetById(int id)
    {
        var item = await _repo.GetByIdAsync(id);
        if (item == null)
            return NotFound(ApiResponse<MemberScheduleItemResponse>.Fail("Member schedule item not found"));

        return Ok(ApiResponse<MemberScheduleItemResponse>.Ok(MapToResponse(item)));
    }

    [HttpPost("project/{projectId}")]
    public async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> CreateForProject(
        int projectId, [FromBody] CreateMemberScheduleItemRequest request)
    {
        if (!await _projectRepo.ExistsAsync(projectId))
            return NotFound(ApiResponse<MemberScheduleItemResponse>.Fail("Project not found"));

        return await CreateInternal(projectId, null, request);
    }

    // Kept for older clients. New entries are owned by the drawing's project.
    [HttpPost("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> CreateForDrawing(
        int drawingId, [FromBody] CreateMemberScheduleItemRequest request)
    {
        var drawing = await _drawingRepo.GetByIdAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<MemberScheduleItemResponse>.Fail("Drawing not found"));

        return await CreateInternal(drawing.ProjectId, drawingId, request);
    }

    private async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> CreateInternal(
        int projectId,
        int? sourceDrawingId,
        CreateMemberScheduleItemRequest request)
    {
        var mark = (request.Mark ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(mark))
            return BadRequest(ApiResponse<MemberScheduleItemResponse>.Fail("Member mark is required"));

        if (await _repo.GetByProjectAndMarkAsync(projectId, mark) != null)
            return Conflict(ApiResponse<MemberScheduleItemResponse>.Fail(
                $"Member '{mark}' already exists in this project's schedule"));

        var totalWeight = request.UnitWeight * request.Length * request.Quantity;

        var item = new MemberScheduleItem
        {
            Mark = mark,
            MemberSize = request.MemberSize,
            MemberType = request.MemberType,
            UnitWeight = request.UnitWeight,
            Length = request.Length,
            Quantity = request.Quantity,
            TotalWeight = totalWeight,
            Description = request.Description,
            TakeoffItemId = request.TakeoffItemId,
            Color = request.Color,
            ProjectId = projectId,
            DrawingId = sourceDrawingId
        };

        await _repo.AddAsync(item);
        return Ok(ApiResponse<MemberScheduleItemResponse>.Ok(MapToResponse(item), "Member schedule item added"));
    }

    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> Update(
        int id, [FromBody] UpdateMemberScheduleItemRequest request)
    {
        var item = await _repo.GetByIdAsync(id);
        if (item == null)
            return NotFound(ApiResponse<MemberScheduleItemResponse>.Fail("Member schedule item not found"));

        var mark = (request.Mark ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(mark))
            return BadRequest(ApiResponse<MemberScheduleItemResponse>.Fail("Member mark is required"));

        var duplicate = await _repo.GetByProjectAndMarkAsync(item.ProjectId, mark);
        if (duplicate != null && duplicate.Id != item.Id)
            return Conflict(ApiResponse<MemberScheduleItemResponse>.Fail(
                $"Member '{mark}' already exists in this project's schedule"));

        item.Mark = mark;
        item.MemberSize = request.MemberSize;
        item.MemberType = request.MemberType;
        item.UnitWeight = request.UnitWeight;
        item.Length = request.Length;
        item.Quantity = request.Quantity;
        item.TotalWeight = request.UnitWeight * request.Length * request.Quantity;
        item.Description = request.Description;
        item.TakeoffItemId = request.TakeoffItemId;
        if (request.Color != null) item.Color = request.Color;

        await _repo.UpdateAsync(item);
        return Ok(ApiResponse<MemberScheduleItemResponse>.Ok(MapToResponse(item), "Member schedule item updated"));
    }

    [HttpDelete("{id}")]
    [HttpPost("{id}/delete")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        var deleted = await _repo.DeleteAsync(id);
        if (!deleted)
            return NotFound(ApiResponse<bool>.Fail("Member schedule item not found"));

        return Ok(ApiResponse<bool>.Ok(true, "Member schedule item deleted"));
    }

    [HttpGet("project/{projectId}/summary")]
    public async Task<ActionResult<ApiResponse<MemberScheduleSummaryResponse>>> GetProjectSummary(int projectId)
    {
        if (!await _projectRepo.ExistsAsync(projectId))
            return NotFound(ApiResponse<MemberScheduleSummaryResponse>.Fail("Project not found"));

        var items = await _repo.GetByProjectIdAsync(projectId);
        return Ok(ApiResponse<MemberScheduleSummaryResponse>.Ok(BuildSummary(items)));
    }

    // Kept for older clients. Summary is now project-wide.
    [HttpGet("drawing/{drawingId}/summary")]
    public async Task<ActionResult<ApiResponse<MemberScheduleSummaryResponse>>> GetDrawingSummary(int drawingId)
    {
        var drawing = await _drawingRepo.GetByIdAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<MemberScheduleSummaryResponse>.Fail("Drawing not found"));

        var items = await _repo.GetByProjectIdAsync(drawing.ProjectId);
        return Ok(ApiResponse<MemberScheduleSummaryResponse>.Ok(BuildSummary(items)));
    }

    private static MemberScheduleSummaryResponse BuildSummary(IEnumerable<MemberScheduleItem> items)
    {
        var list = items.ToList();
        return new MemberScheduleSummaryResponse(
            TotalMembers: list.Count,
            TotalQuantity: list.Sum(i => i.Quantity),
            TotalWeight: list.Sum(i => i.TotalWeight)
        );
    }

    private static MemberScheduleItemResponse MapToResponse(MemberScheduleItem m) => new(
        m.Id, m.Mark, m.MemberSize, m.MemberType,
        m.UnitWeight, m.Length, m.Quantity, m.TotalWeight,
        m.Description, m.TakeoffItemId, m.ProjectId, m.DrawingId, m.CreatedAt,
        m.Color
    );
}
