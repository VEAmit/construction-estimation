using ConstructionEstimation.API.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Newtonsoft.Json;
using Syncfusion.EJ2.PdfViewer;
using System.Text.Json;

namespace ConstructionEstimation.API.Controllers;

[Route("api/pdfviewer")]
[ApiController]
[AllowAnonymous]
public class PdfViewerController : ControllerBase
{
    private readonly AppPaths _paths;
    private readonly ILogger<PdfViewerController> _logger;
    private readonly IMemoryCache _cache;

    public PdfViewerController(
        AppPaths paths,
        ILogger<PdfViewerController> logger,
        IMemoryCache cache)
    {
        _paths = paths;
        _logger = logger;
        _cache = cache;
    }

    // Syncfusion sends mixed JSON types (numbers for startPage, zoomFactor, etc.)
    // PdfRenderer requires Dictionary<string,string> — coerce all values to strings
    private static Dictionary<string, string> ToStringDict(JsonElement body)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in body.EnumerateObject())
        {
            dict[prop.Name] = prop.Value.ValueKind switch
            {
                JsonValueKind.String => prop.Value.GetString() ?? string.Empty,
                JsonValueKind.True   => "true",
                JsonValueKind.False  => "false",
                JsonValueKind.Null   => string.Empty,
                _                    => prop.Value.GetRawText(),
            };
        }
        return dict;
    }

    private PdfRenderer CreateRenderer()
    {
        var tempPath = _paths.PdfViewerTempPath;
        Directory.CreateDirectory(tempPath);
        PdfRenderer.ReferencePath = tempPath;
        return new PdfRenderer(_cache);
    }

    private static string NormalizeBase64Document(string document)
    {
        var value = document.Trim();
        var commaIndex = value.IndexOf(',');
        if (commaIndex >= 0 && value[..commaIndex].Contains("base64", StringComparison.OrdinalIgnoreCase))
            value = value[(commaIndex + 1)..];
        return value;
    }

    [HttpPost("Load")]
    public IActionResult Load([FromBody] JsonElement body)
    {
        try
        {
            var jsonObject = ToStringDict(body);
            var pdfViewer  = CreateRenderer();

            if (!jsonObject.TryGetValue("document", out string? document) || string.IsNullOrEmpty(document))
            {
                var empty = pdfViewer.Load(new MemoryStream(), jsonObject);
                return Content(JsonConvert.SerializeObject(empty), "application/json");
            }

            if (jsonObject.TryGetValue("isFileName", out string? fn) && fn == "true")
                return Content("{\"error\":\"file-based loading not supported\"}", "application/json");

            var stream = new MemoryStream(Convert.FromBase64String(NormalizeBase64Document(document)));
            jsonObject.Remove("document");
            var result = pdfViewer.Load(stream, jsonObject);

            _logger.LogInformation("PdfViewer Load: type={Type}", result?.GetType()?.Name);
            if (result is string json)
            {
                _logger.LogWarning("PdfViewer Load returned string response: {Response}", json);
                return Content(json, "application/json");
            }

            return Content(JsonConvert.SerializeObject(result), "application/json");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PdfViewer Load exception");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // Every action below previously called CreateRenderer()/PdfRenderer methods
    // directly with no try/catch — any exception (native rendering failure,
    // license/environment issue, corrupt file, missing temp-dir permissions,
    // etc.) surfaced as a bare, unlogged 500 with zero diagnostic trail,
    // making it impossible to tell "the PDF itself," "the Syncfusion
    // pipeline," or "environment/config" apart from a bug report alone.
    // RunAction wraps each one the same way Load/RenderPdfPages already were.
    private IActionResult RunAction(string actionName, Func<PdfRenderer, object?> action)
    {
        try
        {
            var result = action(CreateRenderer());
            return Content(result is string s ? (s ?? "null") : JsonConvert.SerializeObject(result), "application/json");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "{Action} exception", actionName);
            return StatusCode(500, new { error = ex.Message, action = actionName });
        }
    }

    [HttpPost("Bookmarks")]
    public IActionResult Bookmarks([FromBody] JsonElement body) =>
        RunAction(nameof(Bookmarks), r => r.GetBookmarks(ToStringDict(body)));

    [HttpPost("RenderPdfPages")]
    public IActionResult RenderPdfPages([FromBody] JsonElement body) =>
        RunAction(nameof(RenderPdfPages), r => r.GetPage(ToStringDict(body)));

    [HttpPost("RenderThumbnailImages")]
    public IActionResult RenderThumbnailImages([FromBody] JsonElement body) =>
        RunAction(nameof(RenderThumbnailImages), r => r.GetThumbnailImages(ToStringDict(body)));

    [HttpPost("RenderAnnotationComments")]
    public IActionResult RenderAnnotationComments([FromBody] JsonElement body) =>
        RunAction(nameof(RenderAnnotationComments), r => r.GetAnnotationComments(ToStringDict(body)));

    [HttpPost("ExportAnnotations")]
    public IActionResult ExportAnnotations([FromBody] JsonElement body) =>
        RunAction(nameof(ExportAnnotations), r => r.ExportAnnotation(ToStringDict(body)));

    [HttpPost("ImportAnnotations")]
    public IActionResult ImportAnnotations([FromBody] JsonElement body) =>
        RunAction(nameof(ImportAnnotations), r => r.ImportAnnotation(ToStringDict(body)));

    [HttpPost("ExportFormFields")]
    public IActionResult ExportFormFields([FromBody] JsonElement body) =>
        RunAction(nameof(ExportFormFields), r => r.ExportFormFields(ToStringDict(body)));

    [HttpPost("ImportFormFields")]
    public IActionResult ImportFormFields([FromBody] JsonElement body) =>
        RunAction(nameof(ImportFormFields), r => r.ImportFormFields(ToStringDict(body)));

    [HttpPost("Unload")]
    public IActionResult Unload([FromBody] JsonElement body) =>
        RunAction(nameof(Unload), r => { r.ClearCache(ToStringDict(body)); return "{\"message\":\"Document unloaded\"}"; });

    [HttpPost("Download")]
    public IActionResult Download([FromBody] JsonElement body) =>
        RunAction(nameof(Download), r => r.GetDocumentAsBase64(ToStringDict(body)));

    [HttpPost("PrintImages")]
    public IActionResult PrintImages([FromBody] JsonElement body) =>
        RunAction(nameof(PrintImages), r => r.GetPrintImage(ToStringDict(body)));

    [HttpPost("Search")]
    public IActionResult Search([FromBody] JsonElement body)
    {
        // Search was removed from PdfRenderer in v33
        return Content("{\"result\":[]}", "application/json");
    }

    [HttpPost("GetDocumentText")]
    public IActionResult GetDocumentText([FromBody] JsonElement body) =>
        RunAction(nameof(GetDocumentText), r => r.GetDocumentText(ToStringDict(body)));

    [HttpPost("RenderPdfTexts")]
    public IActionResult RenderPdfTexts([FromBody] JsonElement body) =>
        RunAction(nameof(RenderPdfTexts), r => r.GetDocumentText(ToStringDict(body)));
}
