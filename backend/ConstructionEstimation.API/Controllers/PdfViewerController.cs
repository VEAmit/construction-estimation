using ConstructionEstimation.API.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Syncfusion.EJ2.PdfViewer;
using System.Text.Json;

namespace ConstructionEstimation.API.Controllers;

[Route("api/pdfviewer")]
[ApiController]
[AllowAnonymous]
public class PdfViewerController : ControllerBase
{
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<PdfViewerController> _logger;
    private readonly PdfViewerCacheManager _cache;

    public PdfViewerController(
        IWebHostEnvironment env,
        ILogger<PdfViewerController> logger,
        PdfViewerCacheManager cache)
    {
        _env = env;
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
        var tempPath = Path.Combine(_env.ContentRootPath, "pdfviewer_temp");
        Directory.CreateDirectory(tempPath);
        PdfRenderer.ReferencePath = tempPath;
        return new PdfRenderer { CacheManager = _cache };
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
            return Content(JsonConvert.SerializeObject(result), "application/json");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PdfViewer Load exception");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpPost("Bookmarks")]
    public IActionResult Bookmarks([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetBookmarks(ToStringDict(body))), "application/json");

    [HttpPost("RenderPdfPages")]
    public IActionResult RenderPdfPages([FromBody] JsonElement body)
    {
        try
        {
            var result = CreateRenderer().GetPage(ToStringDict(body));
            return Content(JsonConvert.SerializeObject(result), "application/json");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RenderPdfPages exception");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpPost("RenderThumbnailImages")]
    public IActionResult RenderThumbnailImages([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetThumbnailImages(ToStringDict(body))), "application/json");

    [HttpPost("RenderAnnotationComments")]
    public IActionResult RenderAnnotationComments([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetAnnotationComments(ToStringDict(body))), "application/json");

    [HttpPost("ExportAnnotations")]
    public IActionResult ExportAnnotations([FromBody] JsonElement body)
    {
        string result = CreateRenderer().ExportAnnotation(ToStringDict(body));
        return Content(result ?? "null", "application/json");
    }

    [HttpPost("ImportAnnotations")]
    public IActionResult ImportAnnotations([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().ImportAnnotation(ToStringDict(body))), "application/json");

    [HttpPost("ExportFormFields")]
    public IActionResult ExportFormFields([FromBody] JsonElement body)
    {
        string result = CreateRenderer().ExportFormFields(ToStringDict(body));
        return Content(result ?? "null", "application/json");
    }

    [HttpPost("ImportFormFields")]
    public IActionResult ImportFormFields([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().ImportFormFields(ToStringDict(body))), "application/json");

    [HttpPost("Unload")]
    public IActionResult Unload([FromBody] JsonElement body)
    {
        CreateRenderer().ClearCache(ToStringDict(body));
        return Content("{\"message\":\"Document unloaded\"}", "application/json");
    }

    [HttpPost("Download")]
    public IActionResult Download([FromBody] JsonElement body)
    {
        string result = CreateRenderer().GetDocumentAsBase64(ToStringDict(body));
        return Content(result ?? "null", "application/json");
    }

    [HttpPost("PrintImages")]
    public IActionResult PrintImages([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetPrintImage(ToStringDict(body))), "application/json");

    [HttpPost("Search")]
    public IActionResult Search([FromBody] JsonElement body)
    {
        // Search was removed from PdfRenderer in v33
        return Content("{\"result\":[]}", "application/json");
    }

    [HttpPost("GetDocumentText")]
    public IActionResult GetDocumentText([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetDocumentText(ToStringDict(body))), "application/json");

    [HttpPost("RenderPdfTexts")]
    public IActionResult RenderPdfTexts([FromBody] JsonElement body) =>
        Content(JsonConvert.SerializeObject(CreateRenderer().GetDocumentText(ToStringDict(body))), "application/json");
}
