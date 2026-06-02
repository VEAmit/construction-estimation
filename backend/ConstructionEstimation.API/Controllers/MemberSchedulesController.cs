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

    public MemberSchedulesController(IMemberScheduleRepository repo) => _repo = repo;

    [HttpGet("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<IEnumerable<MemberScheduleItemResponse>>>> GetByDrawing(int drawingId)
    {
        var items = await _repo.GetByDrawingIdAsync(drawingId);
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

    [HttpPost("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<MemberScheduleItemResponse>>> Create(
        int drawingId, [FromBody] CreateMemberScheduleItemRequest request)
    {
        var totalWeight = request.UnitWeight * request.Length * request.Quantity;

        var item = new MemberScheduleItem
        {
            Mark = request.Mark,
            MemberSize = request.MemberSize,
            MemberType = request.MemberType,
            UnitWeight = request.UnitWeight,
            Length = request.Length,
            Quantity = request.Quantity,
            TotalWeight = totalWeight,
            Description = request.Description,
            TakeoffItemId = request.TakeoffItemId,
            DrawingId = drawingId
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

        item.Mark = request.Mark;
        item.MemberSize = request.MemberSize;
        item.MemberType = request.MemberType;
        item.UnitWeight = request.UnitWeight;
        item.Length = request.Length;
        item.Quantity = request.Quantity;
        item.TotalWeight = request.UnitWeight * request.Length * request.Quantity;
        item.Description = request.Description;
        item.TakeoffItemId = request.TakeoffItemId;

        await _repo.UpdateAsync(item);
        return Ok(ApiResponse<MemberScheduleItemResponse>.Ok(MapToResponse(item), "Member schedule item updated"));
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        var deleted = await _repo.DeleteAsync(id);
        if (!deleted)
            return NotFound(ApiResponse<bool>.Fail("Member schedule item not found"));

        return Ok(ApiResponse<bool>.Ok(true, "Member schedule item deleted"));
    }

    [HttpGet("drawing/{drawingId}/summary")]
    public async Task<ActionResult<ApiResponse<MemberScheduleSummaryResponse>>> GetSummary(int drawingId)
    {
        var items = await _repo.GetByDrawingIdAsync(drawingId);
        var list = items.ToList();

        var summary = new MemberScheduleSummaryResponse(
            TotalMembers: list.Count,
            TotalQuantity: list.Sum(i => i.Quantity),
            TotalWeight: list.Sum(i => i.TotalWeight)
        );

        return Ok(ApiResponse<MemberScheduleSummaryResponse>.Ok(summary));
    }

    private static MemberScheduleItemResponse MapToResponse(MemberScheduleItem m) => new(
        m.Id, m.Mark, m.MemberSize, m.MemberType,
        m.UnitWeight, m.Length, m.Quantity, m.TotalWeight,
        m.Description, m.TakeoffItemId, m.DrawingId, m.CreatedAt
    );
}
