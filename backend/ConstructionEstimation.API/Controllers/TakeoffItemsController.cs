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
public class TakeoffItemsController : ControllerBase
{
    private readonly ITakeoffItemRepository _repo;

    public TakeoffItemsController(ITakeoffItemRepository repo) => _repo = repo;

    [HttpGet("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<IEnumerable<TakeoffItemResponse>>>> GetByDrawing(int drawingId)
    {
        var items = await _repo.GetByDrawingIdAsync(drawingId);
        return Ok(ApiResponse<IEnumerable<TakeoffItemResponse>>.Ok(items.Select(MapToResponse)));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<TakeoffItemResponse>>> GetById(int id)
    {
        var item = await _repo.GetByIdAsync(id);
        if (item == null)
            return NotFound(ApiResponse<TakeoffItemResponse>.Fail("Item not found"));

        return Ok(ApiResponse<TakeoffItemResponse>.Ok(MapToResponse(item)));
    }

    [HttpPost("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<TakeoffItemResponse>>> Create(
        int drawingId, [FromBody] CreateTakeoffItemRequest request)
    {
        var itemType = Enum.TryParse<ItemType>(request.ItemType, true, out var parsed)
            ? parsed : ItemType.Line;
        var unit = Enum.TryParse<MeasurementUnit>(request.Unit, true, out var parsedUnit)
            ? parsedUnit : MeasurementUnit.Mm;

        double? totalWeight = null;
        if (request.UnitWeight.HasValue && request.Length.HasValue)
        {
            // Convert length to meters based on unit for weight calc
            var lengthInMeters = ConvertToMeters(request.Length.Value, unit);
            totalWeight = request.UnitWeight.Value * lengthInMeters * request.Quantity;
        }

        var item = new TakeoffItem
        {
            Mark = request.Mark,
            Description = request.Description,
            ItemType = itemType,
            Length = request.Length,
            Area = request.Area,
            Quantity = request.Quantity,
            Unit = unit,
            Material = request.Material,
            UnitWeight = request.UnitWeight,
            TotalWeight = totalWeight,
            Notes = request.Notes,
            PointsJson = request.PointsJson,
            Color = request.Color,
            Category = request.Category,
            ScaleRatioAtCreation = request.ScaleRatioAtCreation,
            CalibrationUnitAtCreation = request.CalibrationUnitAtCreation,
            DrawingId = drawingId
        };

        await _repo.AddAsync(item);
        return Ok(ApiResponse<TakeoffItemResponse>.Ok(MapToResponse(item), "Item added"));
    }

    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse<TakeoffItemResponse>>> Update(
        int id, [FromBody] UpdateTakeoffItemRequest request)
    {
        var item = await _repo.GetByIdAsync(id);
        if (item == null)
            return NotFound(ApiResponse<TakeoffItemResponse>.Fail("Item not found"));

        ApplyUpdate(item, request);
        await _repo.UpdateAsync(item);
        return Ok(ApiResponse<TakeoffItemResponse>.Ok(MapToResponse(item), "Item updated"));
    }

    [HttpPost("{id}/restore")]
    public async Task<ActionResult<ApiResponse<TakeoffItemResponse>>> Restore(
        int id, [FromBody] UpdateTakeoffItemRequest request)
    {
        var item = await _repo.RestoreAsync(id);
        if (item == null)
            return NotFound(ApiResponse<TakeoffItemResponse>.Fail("Item not found"));

        ApplyUpdate(item, request);
        await _repo.UpdateAsync(item);
        return Ok(ApiResponse<TakeoffItemResponse>.Ok(MapToResponse(item), "Item restored"));
    }

    private static void ApplyUpdate(TakeoffItem item, UpdateTakeoffItemRequest request)
    {
        var unit = Enum.TryParse<MeasurementUnit>(request.Unit, true, out var parsedUnit)
            ? parsedUnit : MeasurementUnit.Mm;

        item.Mark = request.Mark;
        item.Description = request.Description;
        item.Length = request.Length;
        item.Area = request.Area;
        item.Quantity = request.Quantity;
        item.Unit = unit;
        item.Material = request.Material;
        item.UnitWeight = request.UnitWeight;
        item.Notes = request.Notes;
        item.PointsJson = request.PointsJson;
        item.Color = request.Color;
        item.Category = request.Category;
        item.ScaleRatioAtCreation = request.ScaleRatioAtCreation;
        item.CalibrationUnitAtCreation = request.CalibrationUnitAtCreation;

        if (request.UnitWeight.HasValue && request.Length.HasValue)
        {
            var lengthInMeters = ConvertToMeters(request.Length.Value, unit);
            item.TotalWeight = request.UnitWeight.Value * lengthInMeters * request.Quantity;
        }
        else
        {
            item.TotalWeight = null;
        }
    }

    [HttpDelete("{id}")]
    [HttpPost("{id}/delete")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        var deleted = await _repo.DeleteAsync(id);
        if (!deleted)
            return NotFound(ApiResponse<bool>.Fail("Item not found"));

        return Ok(ApiResponse<bool>.Ok(true, "Item deleted"));
    }

    [HttpGet("drawing/{drawingId}/summary")]
    public async Task<ActionResult<ApiResponse<TakeoffSummaryResponse>>> GetSummary(int drawingId)
    {
        var items = await _repo.GetByDrawingIdAsync(drawingId);
        var list = items.ToList();

        var summary = new TakeoffSummaryResponse(
            TotalLength: list.Sum(i => i.Length ?? 0),
            TotalArea: list.Sum(i => i.Area ?? 0),
            TotalWeight: list.Sum(i => i.TotalWeight ?? 0),
            TotalItems: list.Count
        );

        return Ok(ApiResponse<TakeoffSummaryResponse>.Ok(summary));
    }

    private static double ConvertToMeters(double value, MeasurementUnit unit) => unit switch
    {
        MeasurementUnit.Mm => value / 1000.0,
        MeasurementUnit.Cm => value / 100.0,
        MeasurementUnit.Meter => value,
        MeasurementUnit.Feet => value * 0.3048,
        MeasurementUnit.Inch => value * 0.0254,
        _ => value / 1000.0
    };

    private static TakeoffItemResponse MapToResponse(TakeoffItem t) => new(
        t.Id, t.Mark, t.Description, t.ItemType.ToString(),
        t.Length, t.Area, t.Quantity, t.Unit.ToString(),
        t.Material, t.UnitWeight, t.TotalWeight, t.Notes, t.PointsJson,
        t.DrawingId, t.CreatedAt, t.Color, t.Category,
        t.ScaleRatioAtCreation, t.CalibrationUnitAtCreation
    );
}
