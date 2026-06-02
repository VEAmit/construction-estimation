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
    /// Client sends the confirmed/edited list; we bulk-insert into DB.
    /// </summary>
    [HttpPost("drawing/{drawingId}/confirm")]
    public async Task<ActionResult<ApiResponse<int>>> ConfirmExtraction(
        int drawingId,
        [FromBody] BulkCreateMemberScheduleRequest request)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<int>.Fail("Drawing not found"));

        int saved = 0;
        foreach (var item in request.Items)
        {
            var entity = new MemberScheduleItem
            {
                Mark = item.Mark,
                MemberSize = item.MemberSize,
                MemberType = item.MemberType,
                UnitWeight = item.UnitWeight,
                Length = item.Length,
                Quantity = item.Quantity,
                TotalWeight = item.UnitWeight * item.Length * item.Quantity,
                Description = item.Description,
                TakeoffItemId = item.TakeoffItemId,
                DrawingId = drawingId
            };
            await _scheduleRepo.AddAsync(entity);
            saved++;
        }

        _logger.LogInformation("Saved {Count} extracted members for drawing {DrawingId}", saved, drawingId);
        return Ok(ApiResponse<int>.Ok(saved, $"{saved} member(s) saved to schedule"));
    }
}
