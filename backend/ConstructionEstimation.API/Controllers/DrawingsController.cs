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
public class DrawingsController : ControllerBase
{
    private readonly IDrawingRepository _drawingRepo;
    private readonly IProjectRepository _projectRepo;
    private readonly AppPaths _paths;
    private readonly ILogger<DrawingsController> _logger;

    public DrawingsController(
        IDrawingRepository drawingRepo,
        IProjectRepository projectRepo,
        AppPaths paths,
        ILogger<DrawingsController> logger)
    {
        _drawingRepo = drawingRepo;
        _projectRepo = projectRepo;
        _paths = paths;
        _logger = logger;
    }

    [HttpGet("project/{projectId}")]
    public async Task<ActionResult<ApiResponse<IEnumerable<DrawingResponse>>>> GetByProject(int projectId)
    {
        var drawings = await _drawingRepo.GetByProjectIdAsync(projectId);
        var response = drawings.Select(MapToResponse);
        return Ok(ApiResponse<IEnumerable<DrawingResponse>>.Ok(response));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<DrawingResponse>>> GetById(int id)
    {
        var drawing = await _drawingRepo.GetWithTakeoffItemsAsync(id);
        if (drawing == null)
            return NotFound(ApiResponse<DrawingResponse>.Fail("Drawing not found"));

        return Ok(ApiResponse<DrawingResponse>.Ok(MapToResponse(drawing)));
    }

    [HttpPost("upload/{projectId}")]
    [RequestSizeLimit(100_000_000)] // 100 MB
    public async Task<ActionResult<ApiResponse<DrawingResponse>>> Upload(int projectId, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<DrawingResponse>.Fail("No file provided"));

        if (!file.ContentType.Equals("application/pdf", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<DrawingResponse>.Fail("Only PDF files are allowed"));

        var project = await _projectRepo.GetByIdAsync(projectId);
        if (project == null)
            return NotFound(ApiResponse<DrawingResponse>.Fail($"Project {projectId} not found. Please go back to the dashboard and re-open the project."));

        var uploadsDir = _paths.UploadsPath;
        Directory.CreateDirectory(uploadsDir);

        var uniqueName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName)}";
        var filePath = Path.Combine(uploadsDir, uniqueName);

        await using var stream = new FileStream(filePath, FileMode.Create);
        await file.CopyToAsync(stream);

        var drawing = new Drawing
        {
            Name = Path.GetFileNameWithoutExtension(file.FileName),
            FileName = file.FileName,
            FilePath = uniqueName,
            FileSizeBytes = file.Length,
            ProjectId = projectId
        };

        await _drawingRepo.AddAsync(drawing);
        _logger.LogInformation("Drawing {Name} uploaded for project {ProjectId}", drawing.Name, projectId);

        return Ok(ApiResponse<DrawingResponse>.Ok(MapToResponse(drawing), "Drawing uploaded successfully"));
    }

    [HttpGet("{id}/file")]
    [AllowAnonymous]
    public async Task<IActionResult> GetFile(int id)
    {
        var drawing = await _drawingRepo.GetByIdAsync(id);
        if (drawing == null)
            return NotFound();

        var filePath = _paths.UploadedFile(drawing.FilePath);
        if (!System.IO.File.Exists(filePath))
            return NotFound();

        // Enable range requests for large PDFs + proper CORS headers
        Response.Headers.Append("Access-Control-Allow-Origin", "*");
        Response.Headers.Append("Accept-Ranges", "bytes");

        return PhysicalFile(filePath, "application/pdf", drawing.FileName, enableRangeProcessing: true);
    }

    [HttpPut("{id}/calibrate")]
    [HttpPost("{id}/calibrate")]
    public async Task<ActionResult<ApiResponse<bool>>> Calibrate(int id, [FromBody] CalibrateRequest request)
    {
        if (request.ScaleRatio <= 0 || string.IsNullOrWhiteSpace(request.Unit))
            return BadRequest(ApiResponse<bool>.Fail("scaleRatio must be greater than zero and unit is required"));

        var drawing = await _drawingRepo.GetByIdAsync(id);
        if (drawing == null)
            return NotFound(ApiResponse<bool>.Fail("Drawing not found"));

        var updated = await _drawingRepo.UpdateScaleAsync(id, request.ScaleRatio, request.Unit);
        if (!updated)
            return BadRequest(ApiResponse<bool>.Fail("Could not save calibration"));

        return Ok(ApiResponse<bool>.Ok(true, "Scale calibrated successfully"));
    }

    [HttpPost("{id}/reset-calibration")]
    public async Task<ActionResult<ApiResponse<bool>>> ResetCalibration(int id)
    {
        var drawing = await _drawingRepo.GetByIdAsync(id);
        if (drawing == null)
            return NotFound(ApiResponse<bool>.Fail("Drawing not found"));

        var reset = await _drawingRepo.ResetCalibrationAsync(id);
        if (!reset)
            return BadRequest(ApiResponse<bool>.Fail("Could not reset calibration"));

        return Ok(ApiResponse<bool>.Ok(true, "Calibration reset — draw a new reference line to re-calibrate."));
    }

    [HttpPut("{id}/annotations")]
    public async Task<ActionResult<ApiResponse<bool>>> SaveAnnotations(int id, [FromBody] SaveAnnotationsRequest request)
    {
        var updated = await _drawingRepo.UpdateAnnotationsAsync(id, request.AnnotationData);
        if (!updated)
            return NotFound(ApiResponse<bool>.Fail("Drawing not found"));

        return Ok(ApiResponse<bool>.Ok(true, "Annotations saved"));
    }

    [HttpDelete("{id}")]
    [HttpPost("{id}/delete")]
    public async Task<ActionResult<ApiResponse<bool>>> Delete(int id)
    {
        var drawing = await _drawingRepo.GetByIdAsync(id);
        if (drawing == null)
            return NotFound(ApiResponse<bool>.Fail("Drawing not found"));

        var filePath = _paths.UploadedFile(drawing.FilePath);
        if (System.IO.File.Exists(filePath))
            System.IO.File.Delete(filePath);

        await _drawingRepo.DeleteAsync(id);
        return Ok(ApiResponse<bool>.Ok(true, "Drawing deleted"));
    }

    private static DrawingResponse MapToResponse(Drawing d) => new(
        d.Id, d.Name, d.FileName, d.FileSizeBytes, d.PageCount,
        d.ScaleRatio, d.IsCalibrated, d.CalibrationUnit, d.ProjectId,
        d.TakeoffItems?.Count(t => !t.IsDeleted) ?? 0, d.CreatedAt,
        d.AnnotationData
    );
}
