using ConstructionEstimation.API.Services;
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
public class ExtractionController : ControllerBase
{
    private readonly IDrawingRepository _drawingRepo;
    private readonly IMemberScheduleRepository _scheduleRepo;
    private readonly ExtractionService _extractionService;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<ExtractionController> _logger;

    public ExtractionController(
        IDrawingRepository drawingRepo,
        IMemberScheduleRepository scheduleRepo,
        ExtractionService extractionService,
        IWebHostEnvironment env,
        ILogger<ExtractionController> logger)
    {
        _drawingRepo = drawingRepo;
        _scheduleRepo = scheduleRepo;
        _extractionService = extractionService;
        _env = env;
        _logger = logger;
    }

    /// <summary>
    /// Scan the drawing PDF and extract structural steel members using OCR/pattern matching.
    /// Returns a preview — does NOT save to database.
    /// </summary>
    [HttpPost("drawing/{drawingId}")]
    public async Task<ActionResult<ApiResponse<ExtractionResultDto>>> ExtractFromDrawing(int drawingId)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<ExtractionResultDto>.Fail("Drawing not found"));

        var filePath = Path.Combine(_env.ContentRootPath, "Uploads", drawing.FilePath);
        var result = _extractionService.ExtractFromPdf(filePath, drawingId, drawing.Name);

        if (result.Status == "Error")
            return BadRequest(ApiResponse<ExtractionResultDto>.Fail(result.ErrorMessage ?? "Extraction failed"));

        _logger.LogInformation("Extracted {Count} members from drawing {DrawingId}", result.TotalExtracted, drawingId);
        return Ok(ApiResponse<ExtractionResultDto>.Ok(result, $"Extracted {result.TotalExtracted} member(s)"));
    }

    /// <summary>
    /// Confirm and save extracted members to the member schedule.
    /// Client sends the confirmed/edited list; upserts by mark (update existing, add new).
    /// </summary>
    [HttpPost("drawing/{drawingId}/confirm")]
    public async Task<ActionResult<ApiResponse<int>>> ConfirmExtraction(
        int drawingId,
        [FromBody] BulkCreateMemberScheduleRequest request)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<int>.Fail("Drawing not found"));

        var items = DeduplicateByMark(request.Items);
        var existing = (await _scheduleRepo.GetByDrawingIdAsync(drawingId)).ToList();
        var byMark = new Dictionary<string, MemberScheduleItem>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in existing.GroupBy(e => e.Mark.Trim(), StringComparer.OrdinalIgnoreCase))
        {
            var keeper = g.OrderByDescending(x => x.Id).First();
            byMark[g.Key] = keeper;
            foreach (var dup in g.Where(x => x.Id != keeper.Id))
                await _scheduleRepo.DeleteAsync(dup.Id);
        }
        var incomingMarks = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        int saved = 0;
        foreach (var item in items)
        {
            var mark = item.Mark.Trim();
            if (string.IsNullOrEmpty(mark)) continue;
            incomingMarks.Add(mark);

            if (byMark.TryGetValue(mark, out var existingItem))
            {
                existingItem.MemberSize = item.MemberSize;
                existingItem.MemberType = item.MemberType;
                existingItem.Description = item.Description;
                if (item.TakeoffItemId.HasValue)
                    existingItem.TakeoffItemId = item.TakeoffItemId;
                // Preserve length/qty/weight the user entered in the grid
                if (item.UnitWeight > 0) existingItem.UnitWeight = item.UnitWeight;
                if (item.Length > 0) existingItem.Length = item.Length;
                if (item.Quantity > 0) existingItem.Quantity = item.Quantity;
                existingItem.TotalWeight = existingItem.UnitWeight * existingItem.Length * existingItem.Quantity;
                if (!string.IsNullOrEmpty(item.Color)) existingItem.Color = item.Color;
                await _scheduleRepo.UpdateAsync(existingItem);
            }
            else
            {
                var entity = new MemberScheduleItem
                {
                    Mark = mark,
                    MemberSize = item.MemberSize,
                    MemberType = item.MemberType,
                    UnitWeight = item.UnitWeight,
                    Length = item.Length,
                    Quantity = item.Quantity > 0 ? item.Quantity : 1,
                    TotalWeight = item.UnitWeight * item.Length * (item.Quantity > 0 ? item.Quantity : 1),
                    Description = item.Description,
                    TakeoffItemId = item.TakeoffItemId,
                    Color = item.Color,
                    DrawingId = drawingId
                };
                await _scheduleRepo.AddAsync(entity);
            }
            saved++;
        }

        // Drop members no longer found in this extraction pass
        foreach (var old in existing)
        {
            if (!incomingMarks.Contains(old.Mark.Trim()))
                await _scheduleRepo.DeleteAsync(old.Id);
        }

        _logger.LogInformation("Upserted {Count} extracted members for drawing {DrawingId}", saved, drawingId);
        return Ok(ApiResponse<int>.Ok(saved, $"{saved} member(s) saved to schedule"));
    }

    private static List<CreateMemberScheduleItemRequest> DeduplicateByMark(
        List<CreateMemberScheduleItemRequest> items)
    {
        var best = new Dictionary<string, CreateMemberScheduleItemRequest>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            var mark = item.Mark?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(mark)) continue;
            best[mark] = item;
        }
        return best.Values.ToList();
    }
}
