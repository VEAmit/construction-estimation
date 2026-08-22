using ConstructionEstimation.API.Services;
using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Globalization;
using System.Text;

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

    [HttpPost("drawing/{drawingId}/detect-mark")]
    public async Task<ActionResult<ApiResponse<DetectDrawingMarkResponse>>> DetectMarkNearMeasurement(
        int drawingId,
        [FromBody] DetectDrawingMarkRequest request)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<DetectDrawingMarkResponse>.Fail("Drawing not found"));

        var filePath = Path.Combine(_env.ContentRootPath, "Uploads", drawing.FilePath);
        var projectSchedule = (await _scheduleRepo.GetByProjectIdAsync(drawing.ProjectId)).ToList();
        var scheduleDefinedMarks = projectSchedule
            .Where(HasScheduleDefinition)
            .Select(item => item.Mark?.Trim() ?? string.Empty)
            .Where(mark => !string.IsNullOrWhiteSpace(mark))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        // Rows automatically offered from a previous OCR guess use the guessed
        // mark as their placeholder section (RAB1/RAB1, OFG7/OFG7, and so on).
        // Once a real schedule has been extracted, use its defined mark/section
        // rows as the authoritative vocabulary so those guesses cannot reinforce
        // themselves on the next manual measurement.
        var detectionMarks = scheduleDefinedMarks.Count > 0
            ? scheduleDefinedMarks
            : request.KnownMarks ?? [];
        var result = _extractionService.DetectMarkNearMeasurement(
            filePath,
            request.PageNumber,
            request.Points ?? [],
            detectionMarks);

        _logger.LogInformation(
            "Drawing mark detection for drawing {DrawingId}, page {PageNumber}, points {PointCount}: {Mark}",
            drawingId,
            request.PageNumber,
            request.Points?.Count ?? 0,
            string.IsNullOrWhiteSpace(result.Mark) ? "(none)" : result.Mark);

        return Ok(ApiResponse<DetectDrawingMarkResponse>.Ok(result));
    }

    private static bool HasScheduleDefinition(MemberScheduleItem item)
    {
        var mark = NormalizeIdentityPart(item.Mark);
        var section = NormalizeIdentityPart(item.MemberSize);
        if (!string.IsNullOrEmpty(section) && !section.Equals(mark, StringComparison.Ordinal))
            return true;

        var description = NormalizeIdentityPart(item.Description);
        return !string.IsNullOrEmpty(description) &&
               !description.Equals(mark, StringComparison.Ordinal);
    }

    /// <summary>
    /// Confirm and save extracted members to the member schedule.
    /// Client sends the confirmed/edited list. Exact mark + section matches are
    /// shared project-wide; the same mark with a different section remains a
    /// valid independent schedule item.
    /// </summary>
    [HttpPost("drawing/{drawingId}/confirm")]
    public async Task<ActionResult<ApiResponse<ExtractionSaveResultDto>>> ConfirmExtraction(
        int drawingId,
        [FromBody] BulkCreateMemberScheduleRequest request)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(drawingId);
        if (drawing == null)
            return NotFound(ApiResponse<ExtractionSaveResultDto>.Fail("Drawing not found"));

        var submittedItems = request.Items ?? [];
        var items = DeduplicateByMarkAndSection(submittedItems);
        var submittedCount = submittedItems.Count(item => !string.IsNullOrWhiteSpace(item.Mark));
        var duplicateCount = Math.Max(0, submittedCount - items.Count);
        duplicateCount += await _scheduleRepo.ConsolidateExactDuplicatesAsync(drawing.ProjectId);
        var projectItems = (await _scheduleRepo.GetByProjectIdAsync(drawing.ProjectId)).ToList();
        var currentDrawingItems = projectItems.Where(e => e.DrawingId == drawingId).ToList();
        var byIdentity = new Dictionary<string, MemberScheduleItem>(StringComparer.Ordinal);
        var sharedIdentities = new HashSet<string>(StringComparer.Ordinal);

        // Repair exact duplicates left by older builds. A duplicate is only an
        // exact normalized Mark + Section pair; equal marks with different
        // sections are distinct schedule items and are intentionally kept.
        foreach (var group in projectItems.GroupBy(BuildIdentityKey, StringComparer.Ordinal))
        {
            var members = group.ToList();
            var keeper = members
                .OrderByDescending(x => x.DrawingId == null)
                .ThenByDescending(x => x.DrawingId == drawingId)
                .ThenByDescending(x => x.Id)
                .First();

            byIdentity[group.Key] = keeper;
            var distinctSources = members
                .Where(x => x.DrawingId.HasValue)
                .Select(x => x.DrawingId!.Value)
                .Distinct()
                .Count();
            if (members.Any(x => x.DrawingId == null) || distinctSources > 1)
                sharedIdentities.Add(group.Key);

            foreach (var duplicate in members.Where(x => x.Id != keeper.Id))
                await _scheduleRepo.DeleteAsync(duplicate.Id);

            if (sharedIdentities.Contains(group.Key) && keeper.DrawingId.HasValue)
            {
                keeper.DrawingId = null;
                await _scheduleRepo.UpdateAsync(keeper);
            }
        }

        var incomingIdentities = new HashSet<string>(StringComparer.Ordinal);
        var added = 0;
        var updated = 0;

        foreach (var item in items)
        {
            var mark = item.Mark.Trim();
            if (string.IsNullOrEmpty(mark)) continue;
            var identity = BuildIdentityKey(mark, item.MemberSize);
            incomingIdentities.Add(identity);

            if (byIdentity.TryGetValue(identity, out var existingItem))
            {
                var belongsToCurrentDrawing = existingItem.DrawingId == drawingId;
                if (!belongsToCurrentDrawing)
                {
                    // This exact Mark + Section already exists in the shared
                    // project schedule. Keep the original row unchanged and do
                    // not save a second copy from this drawing.
                    if (existingItem.DrawingId.HasValue)
                    {
                        existingItem.DrawingId = null;
                        await _scheduleRepo.UpdateAsync(existingItem);
                    }
                    duplicateCount++;
                    continue;
                }

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

                // The identical schedule item is now known to occur on more
                // than one drawing, so retain it as a project-owned row rather
                // than tying its lifetime to either source drawing.
                if (sharedIdentities.Contains(identity) ||
                    (existingItem.DrawingId.HasValue && existingItem.DrawingId != drawingId))
                {
                    existingItem.DrawingId = null;
                }

                await _scheduleRepo.UpdateAsync(existingItem);
                updated++;
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
                    ProjectId = drawing.ProjectId,
                    DrawingId = drawingId
                };
                await _scheduleRepo.AddAsync(entity);
                byIdentity[identity] = entity;
                added++;
            }
        }

        // Drop members no longer found in this extraction pass.
        // Scoped to the drawing being scanned: the schedule is project-wide, so
        // members contributed by other drawings must survive this pass. Without
        // the DrawingId check, extracting one drawing wipes every other
        // drawing's members out of the shared schedule.
        foreach (var old in currentDrawingItems)
        {
            if (old.DrawingId == drawingId && !incomingIdentities.Contains(BuildIdentityKey(old)))
                await _scheduleRepo.DeleteAsync(old.Id);
        }

        var saved = added + updated;

        _logger.LogInformation(
            "Upserted {Count} extracted members ({Added} added, {Updated} updated); skipped or consolidated {DuplicateCount} exact duplicate(s) in project {ProjectId} from drawing {DrawingId}",
            saved,
            added,
            updated,
            duplicateCount,
            drawing.ProjectId,
            drawingId);

        var response = new ExtractionSaveResultDto(saved, added, updated);
        return Ok(ApiResponse<ExtractionSaveResultDto>.Ok(
            response,
            $"{saved} member(s) saved to the project schedule"));
    }

    private static List<CreateMemberScheduleItemRequest> DeduplicateByMarkAndSection(
        List<CreateMemberScheduleItemRequest> items)
    {
        var best = new Dictionary<string, CreateMemberScheduleItemRequest>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            var mark = item.Mark?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(mark)) continue;
            best[BuildIdentityKey(mark, item.MemberSize)] = item;
        }
        return best.Values.ToList();
    }

    private static string BuildIdentityKey(MemberScheduleItem item) =>
        BuildIdentityKey(item.Mark, item.MemberSize);

    private static string BuildIdentityKey(string? mark, string? memberSize) =>
        $"{NormalizeIdentityPart(mark)}|{NormalizeIdentityPart(memberSize)}";

    private static string NormalizeIdentityPart(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;

        var normalized = value.Normalize(NormalizationForm.FormKC);
        return string.Concat(normalized.Where(character =>
                !char.IsWhiteSpace(character) &&
                CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.Format))
            .Replace('×', 'X')
            .ToUpperInvariant();
    }

}
