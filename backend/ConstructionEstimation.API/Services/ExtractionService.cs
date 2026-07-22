using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using ConstructionEstimation.Core.DTOs;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;
using Tesseract;
using PDFtoImage;
using SkiaSharp;

namespace ConstructionEstimation.API.Services;

public class ExtractionService
{
    private readonly ILogger<ExtractionService> _logger;
    private readonly string _tessDataPath;
    private const int MarkDetectionDpi = 320;
    private static readonly ConcurrentDictionary<string, byte[]> RenderedPagePngCache = new();

    // Shared "mark shape" fragment — an optional 1-2 digit level/storey prefix (e.g. the "1" in
    // "1FB1", "2C3" — common on multi-level structural drawings) followed by the usual
    // letters+digits+letter mark shape. Used everywhere a mark is matched or validated so a
    // level-prefixed mark is captured whole instead of having its leading digit silently
    // dropped (e.g. "1FB1" being read back as just "FB1").
    private const string MarkPrefix = @"\d{0,2}";

    // Optional dot/dash compound suffix for schedule sub-element marks, e.g. a truss schedule's
    // "2T1.EV" (end vertical), "2T1-BC" (bottom chord), "2T1.TC" (top chord) — one member ("2T1")
    // with several sub-parts, printed as a single mark with no space around the separator. Purely
    // additive: only appended where it can't be confused with the "mark - description" separator
    // convention used elsewhere (that separator is always preceded by whitespace; a compound
    // suffix never is), so a plain mark like "SC2" or "1FB1" still matches identically with or
    // without this group present.
    private const string CompoundMarkSuffix = @"(?:[.\-][A-Z]{1,4}\d{0,3}[A-Z]?)?";

    // Weight suffix optional → matches "310 UB 40.4" AND "200 PFC"
    private static readonly Regex SteelSectionPattern = new(
        @"\b(\d{2,4})\s*(UB|UC|PFC|TFC|CHS|RHS|SHS|EA|UA|RSJ|WB|WC|TFB|BFB|HRS)\s*(\d{1,3}(?:\.\d+)?)?\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static readonly Regex HollowSectionPattern = new(
        @"\b(\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*[xX×]\s*(\d{1,2}(?:\.\d+)?))?\s*(RHS|SHS|CHS|EA|UA)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Reid bars on precast plans — "R1 - RB12 REID BARS x 540 LONG..."
    private static readonly Regex ReidBarPattern = new(
        @"\b(RB\d+)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Concrete pad footings / columns / slabs — "1200 × 1200 × 300 DEEP", "600 x 600", "3500×3500×600"
    private static readonly Regex ConcreteDimPattern = new(
        @"\b(\d{3,4})\s*[×xX]\s*(\d{3,4})(?:\s*[×xX]\s*\d{2,4})?\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Lipped-channel purlins/girts — "C20019", "C15015", "C10010" (depth+thickness code, no
    // space, common on roof framing plans — was previously unhandled entirely, meaning every
    // purlin row on a roof plan silently failed to extract regardless of table structure).
    private static readonly Regex PurlinSectionPattern = new(
        @"\bC\d{3,5}\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Rod bracing — "16# ROD", "12mm ROD WITH TURNBUCKLE"
    private static readonly Regex RodBracingPattern = new(
        @"\b\d{1,3}\s*(?:#|mm)\s*ROD\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Marks as shown on drawings: SC2, B1, C7, FB1 — UB/UC or hollow (75 x 5 SHS)
    private static readonly Regex PdfScheduleMarkPattern = new(
        @"\b(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—]\s*(?:\d+\s*)?(?:(?:\d+\s*[xX×]\s*)+\d+(?:\.\d+)?\s*)?(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS|RB\d+)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Table row: mark then section at line start — "SC2  360UB45", "B1 610 UB 113", "1FB1 410UB53.7"
    private static readonly Regex TableRowMarkPattern = new(
        @"^\s*(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s+\d{2,4}\s*(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Drawing list format (COLUMNS / BEAMS / PAD FOOTINGS on structural plans)
    // Note: "/" intentionally excluded — it appears in address text ("Unit 10/18 Stirling HWY")
    // and causes false member matches from the title block.
    private static readonly Regex DrawingListLinePattern = new(
        @"^\s*(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:•]\s*(.+)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Looser pattern used when already inside a drawing-list block — tolerates space-only separator
    // e.g. "PF2  1200 × 1200 × 300 DEEP" (table cell without explicit dash), including a table
    // whose cells are separated by just a single space rather than two-plus — this pattern is
    // only ever used once we're already confirmed to be inside a recognized member-list block
    // (see ParseDrawingLists), so a single space isn't at real risk of matching unrelated prose.
    private static readonly Regex DrawingListLoosePattern = new(
        @"^\s*(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?)\s+(.+)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Unanchored fallback — multi-column drawing sheets (e.g. a PAD FOOTINGS legend sitting
    // beside a DRAWING SCHEDULE and DESIGN CRITERIA block) reconstruct lines purely by Y-band,
    // so an unrelated column header at the same row height (e.g. "LEGEND") can land in front of
    // the real mark ("LEGEND PF2 - 3500 x 3500 x 600 DEEP..."), pushing it off the start of the
    // line and silently defeating the anchored patterns above for that one row while neighbouring
    // rows with no such overlap parse fine. Only tried once already confirmed inside a recognized
    // member-list block (same allowLoose gate as DrawingListLoosePattern), so it can't pick up
    // stray "XX9 -" look-alikes from ordinary prose outside a real list section.
    private static readonly Regex DrawingListAnywherePattern = new(
        @"\b(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:•]\s*(.+)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static readonly string[] ColorPalette = {
        "#3B82F6", "#22C55E", "#F97316", "#A855F7",
        "#06B6D4", "#EAB308", "#EC4899", "#EF4444",
        "#14B8A6", "#F59E0B", "#6366F1", "#84CC16",
    };

    private static readonly string[] DrawingListSections = {
        "COLUMNS", "BEAMS", "RAFTERS", "PURLINS", "GIRTS", "BRACES",
        "FLOOR BEAMS", "FLOORBEAMS", "ROOF BEAMS", "PAD FOOTINGS", "STRUTS",
        "SECONDARY MEMBERS", "OTHERS", "OTHER",
        "FASCIA BEAM", "WALL STIFFENERS", "RAKING ANGLES", "ROOF BRACING",
        "PARAPET", "STUB COLUMNS",
    };

    private static readonly string[] ScheduleHeaders = {
        "member schedule", "steel schedule", "section schedule",
        "beam schedule", "column schedule", "purlin schedule",
        "member mark", "section size", "unit weight",
        "item member section", "member section type", "section type description",
    };

    private static readonly string[] MetadataNoiseTokens = {
        "project title", "company logo", "tender", "revision", "drawing number",
        "scale", "date", "stirling", "nedlands", "government of", "department of",
        "buildings and contracts", "terpkos", "architect", "client", "drawn",
        // Generic (not project-specific) revision/legend/general-note noise —
        // safe to apply to any drawing, unlike the hardcoded company/address tokens above.
        "legend", "denotes", "issued for", "amendment", "addendum",
        "do not scale", "unless noted otherwise", "not to scale",
    };

    public ExtractionService(ILogger<ExtractionService> logger, IWebHostEnvironment env)
    {
        _logger = logger;
        _tessDataPath = Path.Combine(env.ContentRootPath, "tessdata");
    }

    public ExtractionResultDto ExtractFromPdf(string filePath, int drawingId, string drawingName)
    {
        if (!File.Exists(filePath))
            return new ExtractionResultDto(drawingId, drawingName, 0, 0, [], [],
                "Error", $"PDF file not found: {Path.GetFileName(filePath)}");

        try
        {
            var allLines = new List<string>();
            int pageCount;
            string extractionMethod;

            // ── Step 1: try native text extraction (fast, works for text PDFs) ──
            using (var pdf = PdfDocument.Open(filePath))
            {
                pageCount = pdf.NumberOfPages;
                foreach (var page in pdf.GetPages())
                {
                    var words = page.GetWords().ToList();
                    // Full-page extraction (catches everything in text layer)
                    allLines.AddRange(ReconstructLines(words));
                    // Targeted schedule region extraction: finds MEMBER SCHEDULE header by
                    // bounding-box coordinates, then reconstructs lines from only those words.
                    // This gives clean schedule rows even when the full-page extraction mixes
                    // schedule text with drawing plan text on the same Y-band.
                    allLines.AddRange(ExtractScheduleRegionLines(words));
                }
            }

            bool hasText = allLines.Any(l => l.Trim().Length > 3);

            // ── Step 2: fallback to OCR for image/scanned PDFs ──
            if (!hasText)
            {
                _logger.LogInformation(
                    "Drawing {DrawingId}: no text layer found — running OCR", drawingId);

                try
                {
                    var ocrLines = ExtractViaOcr(filePath, out int ocrPages);
                    if (ocrLines.Count > 0)
                    {
                        allLines = ocrLines;
                        pageCount = ocrPages;
                        extractionMethod = "OCR";
                    }
                    else
                    {
                        extractionMethod = "None";
                    }
                }
                catch (Exception ocrEx)
                {
                    _logger.LogWarning(ocrEx,
                        "OCR failed for drawing {DrawingId}: {Msg}", drawingId, ocrEx.Message);
                    extractionMethod = "Error";
                    return new ExtractionResultDto(drawingId, drawingName, pageCount, 0, [], [],
                        "Error", $"OCR failed: {ocrEx.Message}");
                }
            }
            else
            {
                extractionMethod = "Text";
            }

            var fullText = string.Join(" ", allLines);
            var members = ParseMembers(allLines, fullText);

            if (ShouldRunScheduleOcr(allLines, members))
            {
                _logger.LogInformation(
                    "Drawing {DrawingId}: selectable text exists but schedule candidates are weak ({Count} member(s)) — running targeted schedule OCR",
                    drawingId, members.Count);

                var scheduleOcrLines = ExtractScheduleViaOcr(filePath, out int ocrPages);
                if (scheduleOcrLines.Count > 0)
                {
                    allLines.AddRange(scheduleOcrLines);
                    pageCount = Math.Max(pageCount, ocrPages);
                    extractionMethod = extractionMethod == "Text" ? "Text+ScheduleOCR" : $"{extractionMethod}+ScheduleOCR";
                    fullText = string.Join(" ", allLines);
                    members = ParseMembers(allLines, fullText);
                }
            }

            _logger.LogInformation(
                "Drawing {DrawingId}: extraction method={Method}, lines={Lines}, members={Members}",
                drawingId, extractionMethod, allLines.Count, members.Count);

            // Prefer schedule-relevant lines for the raw sample (shows where extraction found/missed marks)
            var rawSample = BuildRawSample(allLines);

            return new ExtractionResultDto(
                drawingId, drawingName, pageCount,
                members.Count, members, rawSample,
                "Success", null
            );
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PDF extraction failed for drawing {DrawingId}", drawingId);
            return new ExtractionResultDto(drawingId, drawingName, 0, 0, [], [],
                "Error", ex.Message);
        }
    }

    public DetectDrawingMarkResponse DetectMarkNearMeasurement(
        string filePath,
        int pageNumber,
        List<MarkDetectionPointDto> points,
        List<string> knownMarks)
    {
        if (!File.Exists(filePath) || points.Count < 2 || knownMarks.Count == 0)
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        if (!Directory.Exists(_tessDataPath) ||
            !File.Exists(Path.Combine(_tessDataPath, "eng.traineddata")))
        {
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);
        }

        var known = knownMarks
            .Where(m => !string.IsNullOrWhiteSpace(m))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (known.Count == 0) return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        using var pdf = PdfDocument.Open(filePath);
        var pageIndex = Math.Clamp(pageNumber, 1, pdf.NumberOfPages) - 1;
        var pdfPage = pdf.GetPage(pageIndex + 1);
        var pageWidth = pdfPage.Width;
        var pageHeight = pdfPage.Height;

        using var engine = new TesseractEngine(_tessDataPath, "eng", EngineMode.Default);
        engine.SetVariable("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
        engine.SetVariable("preserve_interword_spaces", "1");

        var bitmap = GetRenderedPageBitmap(filePath, pageIndex, MarkDetectionDpi);
        if (bitmap == null) return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        try
        {
            var crops = BuildMeasurementMarkCropCandidates(points, pageWidth, pageHeight, bitmap.Width, bitmap.Height);
            var rawLines = new List<string>();
            var bestMark = string.Empty;
            var bestScore = double.NegativeInfinity;

            for (var i = 0; i < crops.Count; i++)
            {
                var crop = crops[i];
                var lines = OcrMeasurementMarkRegion(engine, bitmap, crop);
                rawLines.AddRange(lines);
                foreach (var line in lines)
                {
                    foreach (var candidate in ExtractKnownMarkCandidates(line, known))
                    {
                        var score = ScoreDetectedMark(candidate, line, known) + Math.Max(0, crops.Count - i);
                        if (score > bestScore)
                        {
                            bestScore = score;
                            bestMark = known.FirstOrDefault(m => m.Equals(candidate, StringComparison.OrdinalIgnoreCase)) ?? candidate;
                        }
                    }
                }

                if (!string.IsNullOrWhiteSpace(bestMark) && bestScore >= 145)
                    return new DetectDrawingMarkResponse(bestMark, string.Join(" | ", rawLines.Distinct().Take(20)));
            }

            return new DetectDrawingMarkResponse(bestMark, string.Join(" | ", rawLines.Distinct().Take(20)));
        }
        finally
        {
            bitmap.Dispose();
        }
    }

    // ── OCR pipeline ────────────────────────────────────────────────────────────

    private List<string> ExtractViaOcr(string pdfPath, out int pageCount)
    {
        pageCount = 0;
        var lines = new List<string>();

        if (!Directory.Exists(_tessDataPath) ||
            !File.Exists(Path.Combine(_tessDataPath, "eng.traineddata")))
        {
            throw new FileNotFoundException(
                $"Tesseract tessdata not found at {_tessDataPath}. " +
                "Please ensure tessdata/eng.traineddata exists in the API root.");
        }

        using var engine = new TesseractEngine(_tessDataPath, "eng", EngineMode.Default);
        engine.SetVariable("tessedit_char_whitelist", "");  // allow all characters

        using var pdfStream = File.OpenRead(pdfPath);

        // Render at 200 DPI for OCR quality
        var renderOptions = new RenderOptions(Dpi: 200);
        var pageImages = Conversion.ToImages(pdfStream, options: renderOptions);

        foreach (var bitmap in pageImages)
        {
            pageCount++;

            // Encode SKBitmap → PNG bytes → Tesseract Pix
            using var pngData = bitmap.Encode(SKEncodedImageFormat.Png, 100);
            var pngBytes = pngData.ToArray();

            using var pix = Pix.LoadFromMemory(pngBytes);
            using var tessPage = engine.Process(pix);

            var text = tessPage.GetText() ?? string.Empty;
            var pageLines = text
                .Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Trim())
                .Where(l => l.Length > 1)
                .ToList();

            lines.AddRange(pageLines);
            bitmap.Dispose();
        }

        return lines;
    }

    // ── PdfPig line reconstruction ───────────────────────────────────────────────

    private List<string> ExtractScheduleViaOcr(string pdfPath, out int pageCount)
    {
        pageCount = 0;
        var lines = new List<string>();

        if (!Directory.Exists(_tessDataPath) ||
            !File.Exists(Path.Combine(_tessDataPath, "eng.traineddata")))
        {
            throw new FileNotFoundException(
                $"Tesseract tessdata not found at {_tessDataPath}. " +
                "Please ensure tessdata/eng.traineddata exists in the API root.");
        }

        using var engine = new TesseractEngine(_tessDataPath, "eng", EngineMode.Default);
        engine.SetVariable("tessedit_char_whitelist", "");
        engine.SetVariable("preserve_interword_spaces", "1");

        using var pdfStream = File.OpenRead(pdfPath);
        var renderOptions = new RenderOptions(Dpi: MarkDetectionDpi);
        var pageImages = Conversion.ToImages(pdfStream, options: renderOptions);

        foreach (var bitmap in pageImages)
        {
            pageCount++;
            CacheRenderedPageBitmap(pdfPath, pageCount - 1, MarkDetectionDpi, bitmap);
            var bestLines = new List<string>();
            var bestScore = 0;

            foreach (var crop in BuildScheduleCropCandidates(bitmap.Width, bitmap.Height))
            {
                var cropLines = OcrBitmapRegion(engine, bitmap, crop, upscale: 2);
                var score = ScoreScheduleOcrLines(cropLines);
                if (score > bestScore)
                {
                    bestScore = score;
                    bestLines = cropLines;
                }
            }

            if (bestScore > 0 && bestLines.Count > 0)
            {
                _logger.LogInformation(
                    "Schedule OCR page {Page}: selected candidate score={Score}, lines={Lines}",
                    pageCount, bestScore, bestLines.Count);

                lines.Add("MEMBER SCHEDULE ITEM MEMBER SECTION TYPE DESCRIPTION");
                lines.AddRange(bestLines);
            }

            bitmap.Dispose();
        }

        return lines;
    }

    private static SKBitmap? GetRenderedPageBitmap(string pdfPath, int pageIndex, int dpi)
    {
        var key = BuildRenderedPageCacheKey(pdfPath, pageIndex, dpi);
        if (RenderedPagePngCache.TryGetValue(key, out var cachedBytes))
        {
            return SKBitmap.Decode(cachedBytes);
        }

        using var pdfStream = File.OpenRead(pdfPath);
        var renderOptions = new RenderOptions(Dpi: dpi);
        var pageImages = Conversion.ToImages(pdfStream, options: renderOptions);
        var bitmap = pageImages.Skip(pageIndex).FirstOrDefault();
        if (bitmap == null) return null;

        CacheRenderedPageBitmap(pdfPath, pageIndex, dpi, bitmap);
        return bitmap;
    }

    private static void CacheRenderedPageBitmap(string pdfPath, int pageIndex, int dpi, SKBitmap bitmap)
    {
        var key = BuildRenderedPageCacheKey(pdfPath, pageIndex, dpi);
        if (RenderedPagePngCache.ContainsKey(key)) return;

        using var png = bitmap.Encode(SKEncodedImageFormat.Png, 100);
        RenderedPagePngCache.TryAdd(key, png.ToArray());
    }

    private static string BuildRenderedPageCacheKey(string pdfPath, int pageIndex, int dpi)
    {
        var info = new FileInfo(pdfPath);
        return $"{info.FullName}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|p{pageIndex}|dpi{dpi}";
    }

    private static List<SKRectI> BuildScheduleCropCandidates(int width, int height)
    {
        static SKRectI Rect(double left, double top, double right, double bottom, int w, int h)
        {
            var l = Math.Clamp((int)Math.Round(w * left), 0, w - 1);
            var t = Math.Clamp((int)Math.Round(h * top), 0, h - 1);
            var r = Math.Clamp((int)Math.Round(w * right), l + 1, w);
            var b = Math.Clamp((int)Math.Round(h * bottom), t + 1, h);
            return new SKRectI(l, t, r, b);
        }

        return
        [
            Rect(0.760, 0.030, 0.995, 0.320, width, height),
            Rect(0.735, 0.025, 0.995, 0.350, width, height),
            Rect(0.770, 0.035, 0.995, 0.425, width, height),
            Rect(0.700, 0.020, 0.995, 0.380, width, height),
        ];
    }

    private static List<string> OcrBitmapRegion(TesseractEngine engine, SKBitmap source, SKRectI crop, int upscale)
    {
        using var cropped = new SKBitmap(crop.Width, crop.Height);
        using (var canvas = new SKCanvas(cropped))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, crop, new SKRect(0, 0, crop.Width, crop.Height));
        }

        using var scaled = new SKBitmap(cropped.Width * upscale, cropped.Height * upscale);
        using (var canvas = new SKCanvas(scaled))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(cropped, new SKRect(0, 0, scaled.Width, scaled.Height));
        }

        using var pngData = scaled.Encode(SKEncodedImageFormat.Png, 100);
        using var pix = Pix.LoadFromMemory(pngData.ToArray());
        using var tessPage = engine.Process(pix, PageSegMode.SingleBlock);

        return (tessPage.GetText() ?? string.Empty)
            .Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => NormalizeScheduleOcrLine(Regex.Replace(l.Trim(), @"\s+", " ")))
            .Where(l => l.Length > 1 && !IsMetadataLine(l))
            .ToList();
    }

    private static List<string> OcrMeasurementMarkRegion(TesseractEngine engine, SKBitmap source, SKRectI crop)
    {
        var lines = new List<string>();
        foreach (var mode in new[] { PageSegMode.SingleWord, PageSegMode.SingleLine, PageSegMode.SparseText })
        {
            lines.AddRange(OcrMeasurementMarkRegion(engine, source, crop, mode, highContrast: true));
        }

        return lines
            .Select(l => Regex.Replace(l.Trim(), @"\s+", " "))
            .Where(l => l.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<string> OcrMeasurementMarkRegion(
        TesseractEngine engine,
        SKBitmap source,
        SKRectI crop,
        PageSegMode pageSegMode,
        bool highContrast)
    {
        using var cropped = new SKBitmap(crop.Width, crop.Height);
        using (var canvas = new SKCanvas(cropped))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, crop, new SKRect(0, 0, crop.Width, crop.Height));
        }

        var maxCropSide = Math.Max(cropped.Width, cropped.Height);
        var upscale = Math.Clamp((int)Math.Floor(2200.0 / Math.Max(maxCropSide, 1)), 3, 8);
        using var scaled = new SKBitmap(cropped.Width * upscale, cropped.Height * upscale);
        using (var canvas = new SKCanvas(scaled))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(cropped, new SKRect(0, 0, scaled.Width, scaled.Height));
        }

        if (highContrast)
        {
            for (var y = 0; y < scaled.Height; y++)
            {
                for (var x = 0; x < scaled.Width; x++)
                {
                    var c = scaled.GetPixel(x, y);
                    var lum = (c.Red * 0.299) + (c.Green * 0.587) + (c.Blue * 0.114);
                    scaled.SetPixel(x, y, lum < 205 ? SKColors.Black : SKColors.White);
                }
            }
            RemoveLongLineRuns(scaled);
            RemoveDottedGuideRuns(scaled);
        }

        using var pngData = scaled.Encode(SKEncodedImageFormat.Png, 100);
        using var pix = Pix.LoadFromMemory(pngData.ToArray());
        using var tessPage = engine.Process(pix, pageSegMode);

        return (tessPage.GetText() ?? string.Empty)
            .Split(new[] { '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => Regex.Replace(l.Trim(), @"\s+", " "))
            .Where(l => l.Length > 0)
            .ToList();
    }

    private static void RemoveLongLineRuns(SKBitmap bitmap)
    {
        var horizontalThreshold = Math.Max(45, bitmap.Width / 4);
        for (var y = 0; y < bitmap.Height; y++)
        {
            var runStart = -1;
            for (var x = 0; x <= bitmap.Width; x++)
            {
                var isBlack = x < bitmap.Width && bitmap.GetPixel(x, y).Red < 32;
                if (isBlack && runStart < 0) runStart = x;
                if ((!isBlack || x == bitmap.Width) && runStart >= 0)
                {
                    var runLength = x - runStart;
                    if (runLength >= horizontalThreshold)
                    {
                        for (var xx = runStart; xx < x; xx++) bitmap.SetPixel(xx, y, SKColors.White);
                    }
                    runStart = -1;
                }
            }
        }

        var verticalThreshold = Math.Max(45, bitmap.Height / 3);
        for (var x = 0; x < bitmap.Width; x++)
        {
            var runStart = -1;
            for (var y = 0; y <= bitmap.Height; y++)
            {
                var isBlack = y < bitmap.Height && bitmap.GetPixel(x, y).Red < 32;
                if (isBlack && runStart < 0) runStart = y;
                if ((!isBlack || y == bitmap.Height) && runStart >= 0)
                {
                    var runLength = y - runStart;
                    if (runLength >= verticalThreshold)
                    {
                        for (var yy = runStart; yy < y; yy++) bitmap.SetPixel(x, yy, SKColors.White);
                    }
                    runStart = -1;
                }
            }
        }
    }

    private static void RemoveDottedGuideRuns(SKBitmap bitmap)
    {
        var columnThreshold = Math.Max(14, bitmap.Height / 28);
        for (var x = 0; x < bitmap.Width; x++)
        {
            var blackCount = 0;
            var runs = 0;
            var inRun = false;
            for (var y = 0; y < bitmap.Height; y++)
            {
                var isBlack = bitmap.GetPixel(x, y).Red < 32;
                if (isBlack)
                {
                    blackCount++;
                    if (!inRun)
                    {
                        runs++;
                        inRun = true;
                    }
                }
                else
                {
                    inRun = false;
                }
            }

            if (blackCount >= columnThreshold && runs >= 6)
            {
                for (var xx = Math.Max(0, x - 1); xx <= Math.Min(bitmap.Width - 1, x + 1); xx++)
                {
                    for (var y = 0; y < bitmap.Height; y++) bitmap.SetPixel(xx, y, SKColors.White);
                }
            }
        }

        var rowThreshold = Math.Max(14, bitmap.Width / 28);
        for (var y = 0; y < bitmap.Height; y++)
        {
            var blackCount = 0;
            var runs = 0;
            var inRun = false;
            for (var x = 0; x < bitmap.Width; x++)
            {
                var isBlack = bitmap.GetPixel(x, y).Red < 32;
                if (isBlack)
                {
                    blackCount++;
                    if (!inRun)
                    {
                        runs++;
                        inRun = true;
                    }
                }
                else
                {
                    inRun = false;
                }
            }

            if (blackCount >= rowThreshold && runs >= 6)
            {
                for (var yy = Math.Max(0, y - 1); yy <= Math.Min(bitmap.Height - 1, y + 1); yy++)
                {
                    for (var x = 0; x < bitmap.Width; x++) bitmap.SetPixel(x, yy, SKColors.White);
                }
            }
        }
    }

    private static List<SKRectI> BuildMeasurementMarkCropCandidates(
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight,
        int bitmapWidth,
        int bitmapHeight)
    {
        static double N(double value, double size) => value >= 0 && value <= 1 ? value * size : value;

        var mapped = points
            .Select(p => new
            {
                X = N(p.X, pageWidth) / pageWidth * bitmapWidth,
                Y = N(p.Y, pageHeight) / pageHeight * bitmapHeight
            })
            .Where(p => double.IsFinite(p.X) && double.IsFinite(p.Y))
            .ToList();

        if (mapped.Count < 2) return [];

        var first = mapped.First();
        var last = mapped.Last();
        var minX = mapped.Min(p => p.X);
        var maxX = mapped.Max(p => p.X);
        var minY = mapped.Min(p => p.Y);
        var maxY = mapped.Max(p => p.Y);
        var dx = maxX - minX;
        var dy = maxY - minY;
        var lineLen = Math.Sqrt(dx * dx + dy * dy);
        var stripX = Math.Clamp(lineLen * 0.28, 60, 160);
        var stripY = Math.Clamp(lineLen * 0.09, 20, 46);
        var looseX = Math.Clamp(lineLen * 0.42, 95, 220);
        var looseY = Math.Clamp(lineLen * 0.18, 38, 90);
        var endpointX = Math.Clamp(lineLen * 0.78, 220, 520);
        var endpointY = Math.Clamp(lineLen * 0.24, 80, 150);
        var len = Math.Sqrt(Math.Pow(last.X - first.X, 2) + Math.Pow(last.Y - first.Y, 2));
        var nx = len > 0 ? -(last.Y - first.Y) / len : 0;
        var ny = len > 0 ? (last.X - first.X) / len : -1;
        var midX = (first.X + last.X) / 2;
        var midY = (first.Y + last.Y) / 2;

        SKRectI RectAround(double cx, double cy, double rx, double ry)
        {
            var l = Math.Clamp((int)Math.Round(cx - rx), 0, bitmapWidth - 1);
            var t = Math.Clamp((int)Math.Round(cy - ry), 0, bitmapHeight - 1);
            var r = Math.Clamp((int)Math.Round(cx + rx), l + 1, bitmapWidth);
            var b = Math.Clamp((int)Math.Round(cy + ry), t + 1, bitmapHeight);
            return new SKRectI(l, t, r, b);
        }

        return new List<SKRectI>
        {
            RectAround(midX, midY, stripX, stripY),
            RectAround(midX + nx * 24, midY + ny * 24, stripX, stripY),
            RectAround(midX - nx * 24, midY - ny * 24, stripX, stripY),
            RectAround(midX + nx * 48, midY + ny * 48, stripX, stripY),
            RectAround(midX - nx * 48, midY - ny * 48, stripX, stripY),
            RectAround(midX + nx * 72, midY + ny * 72, stripX, stripY),
            RectAround(midX - nx * 72, midY - ny * 72, stripX, stripY),
            RectAround(first.X, first.Y, stripX, stripY),
            RectAround(last.X, last.Y, stripX, stripY),
            RectAround(first.X, first.Y, endpointX, endpointY),
            RectAround(last.X, last.Y, endpointX, endpointY),
            RectAround(midX, midY, looseX, looseY),
            RectAround(midX + nx * 42, midY + ny * 42, looseX, looseY),
            RectAround(midX - nx * 42, midY - ny * 42, looseX, looseY),
        }
            .GroupBy(r => $"{r.Left}:{r.Top}:{r.Right}:{r.Bottom}")
            .Select(g => g.First())
            .ToList();
    }

    private static IEnumerable<string> ExtractKnownMarkCandidates(string text, List<string> knownMarks)
    {
        var compact = Regex.Replace(text.ToUpperInvariant(), @"[^A-Z0-9]", "");
        foreach (var mark in knownMarks)
        {
            var upper = mark.Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(upper)) continue;
            if (BuildMarkOcrVariants(upper).Any(compact.Contains)) yield return upper;
        }

        foreach (Match match in Regex.Matches(text.ToUpperInvariant(), @"\b[A-Z]{1,4}\d{1,3}[A-Z]?\b"))
        {
            var token = match.Value.Trim().ToUpperInvariant();
            if (knownMarks.Any(m => m.Equals(token, StringComparison.OrdinalIgnoreCase)))
                yield return token;
        }
    }

    private static IEnumerable<string> BuildMarkOcrVariants(string mark)
    {
        var compact = Regex.Replace(mark.ToUpperInvariant(), @"[^A-Z0-9]", "");
        if (string.IsNullOrEmpty(compact)) yield break;

        yield return compact;
        yield return compact.Replace('B', '8');
        yield return compact.Replace('O', '0');
        yield return compact.Replace('I', '1').Replace('L', '1');
        yield return compact.Replace('S', '5');
        yield return compact.Replace('Z', '2');
        yield return compact.Replace('9', 'O');
        yield return compact.Replace('4', 'A');
        yield return compact.Replace('6', 'G');
        yield return compact.Replace("1", "I");
        yield return compact.Replace("1", "L");
        yield return compact.Replace("0", "O");
        yield return compact.Replace("5", "S");

        foreach (var variant in BuildCombinedMarkOcrVariants(compact))
            yield return variant;
    }

    private static IEnumerable<string> BuildCombinedMarkOcrVariants(string compact)
    {
        static char[] Alternatives(char c) => c switch
        {
            'B' => ['B', '8', 'P', 'R'],
            '8' => ['8', 'B'],
            '9' => ['9', 'O', '0', 'G', 'Q'],
            '6' => ['6', 'G'],
            '0' => ['0', 'O'],
            'O' => ['O', '0'],
            '1' => ['1', 'I', 'L'],
            'I' => ['I', '1', 'L'],
            'L' => ['L', '1', 'I'],
            '5' => ['5', 'S'],
            'S' => ['S', '5'],
            '2' => ['2', 'Z'],
            'Z' => ['Z', '2'],
            _ => [c],
        };

        var variants = new List<string> { string.Empty };
        foreach (var c in compact)
        {
            var next = new List<string>();
            foreach (var prefix in variants)
            {
                foreach (var alt in Alternatives(c))
                    next.Add(prefix + alt);
            }
            variants = next;
            if (variants.Count > 128) break;
        }

        return variants
            .Where(v => v.Length == compact.Length)
            .Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static double ScoreDetectedMark(string mark, string sourceLine, List<string> knownMarks)
    {
        var upper = mark.ToUpperInvariant();
        var line = Regex.Replace(sourceLine.ToUpperInvariant(), @"\s+", "");
        var score = 100.0;
        if (knownMarks.Any(m => m.Equals(upper, StringComparison.OrdinalIgnoreCase))) score += 50;
        if (line.Equals(upper, StringComparison.OrdinalIgnoreCase)) score += 40;
        if (line.Contains(upper)) score += 20;
        var variants = BuildMarkOcrVariants(upper).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (variants.Any(v => line.Equals(v, StringComparison.OrdinalIgnoreCase))) score += 35;
        if (variants.Any(v => !string.IsNullOrWhiteSpace(v) && line.Contains(v, StringComparison.OrdinalIgnoreCase))) score += 18;
        score -= Math.Max(0, line.Length - upper.Length) * 0.75;
        return score;
    }

    private static string NormalizeScheduleOcrLine(string line)
    {
        // In small schedule mark columns Tesseract can drop or confuse one glyph:
        // C1 -> 1, C5 -> CS, HB5 -> HBS. Keep this scoped to targeted schedule OCR.
        line = Regex.Replace(line, @"^1\s+(?=\d{2,4}\s*(?:x|X|×|SHS|RHS|CHS|UB|PFC)\b)", "C1 ");
        line = Regex.Replace(line, @"^8\s+S?50\s+SHS\b", "C8 50 SHS", RegexOptions.IgnoreCase);
        line = Regex.Replace(line, @"^CS\s+(?=\d{2,4}|\d{2,3}\.\d|C\d)", "C5 ", RegexOptions.IgnoreCase);
        line = Regex.Replace(line, @"^HBS\s+(?=\(?C?\d{2,4}|\d{2,4}\s*(?:x|X|×|SHS|RHS|CHS|UB|PFC)\b)", "HB5 ", RegexOptions.IgnoreCase);
        return line;
    }

    private static int ScoreScheduleOcrLines(List<string> lines)
    {
        var score = 0;
        foreach (var line in lines)
        {
            var upper = line.ToUpperInvariant();
            if (upper.Contains("ITEM") && upper.Contains("MEMBER")) score += 8;
            if (upper.Contains("SECTION") && upper.Contains("TYPE")) score += 8;
            if (upper.Contains("DESCRIPTION")) score += 4;
            if (Regex.IsMatch(upper, @"\b(C|HB|WB|DF|PF|SF|RW)\s*\d{1,3}[A-Z]?\b")) score += 3;
            if (Regex.IsMatch(upper, @"^\s*\d+\s+[A-Z]{1,4}\s*\d{1,3}[A-Z]?\b")) score += 2;
        }
        return score;
    }

    private static bool ShouldRunScheduleOcr(List<string> lines, List<ExtractedMemberDto> members)
    {
        if (members.Count >= 5) return false;

        var fullText = string.Join(" ", lines).ToLowerInvariant();
        var hasOnlyMetadataText = MetadataNoiseTokens.Any(t => fullText.Contains(t));
        var hasScheduleSignal = ScheduleHeaders.Any(h => fullText.Contains(h))
            || Regex.IsMatch(fullText, @"\b(item|member)\s+(member|section)\b", RegexOptions.IgnoreCase);

        return hasOnlyMetadataText || !hasScheduleSignal || members.Count == 0;
    }

    private static bool IsMetadataLine(string line)
    {
        var lower = line.ToLowerInvariant();
        return MetadataNoiseTokens.Any(lower.Contains)
            || Regex.IsMatch(lower, @"\b(ph\.|www\.|\.com|@|drawing no|drawn|checked|approved)\b");
    }

    private static List<string> ReconstructLines(List<Word> words)
    {
        if (words.Count == 0) return [];

        // 5.0 pt tolerance groups words within the same visual line even with slight
        // vertical offsets common in structural drawing schedules.
        const double tolerance = 5.0;
        var groups = new Dictionary<int, List<Word>>();

        foreach (var w in words)
        {
            var yBucket = (int)(Math.Round(w.BoundingBox.Bottom / tolerance) * tolerance);
            if (!groups.TryGetValue(yBucket, out var list))
                groups[yBucket] = list = [];
            list.Add(w);
        }

        return groups
            .OrderByDescending(g => g.Key)
            .Select(g =>
                string.Join(" ", g.Value.OrderBy(w => w.BoundingBox.Left).Select(w => w.Text)))
            .Where(l => l.Trim().Length > 0)
            .ToList();
    }

    /// <summary>
    /// Finds the MEMBER SCHEDULE header in the page word list by bounding-box coordinates,
    /// then reconstructs lines from only the words within that schedule region.
    /// This prevents schedule rows from being mixed with main-drawing plan text that shares
    /// the same Y-band on large A1/A2/A3 engineering drawings.
    /// </summary>
    private static List<string> ExtractScheduleRegionLines(List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        // Find "MEMBER SCHEDULE" header — two adjacent words on the same visual line.
        double headerBottom = -1, tableLeft = -1;
        var schedWords = pageWords
            .Where(w => w.Text.Equals("SCHEDULE", StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (var sw in schedWords)
        {
            var memberWord = pageWords.FirstOrDefault(w =>
                w.Text.Equals("MEMBER", StringComparison.OrdinalIgnoreCase) &&
                Math.Abs(w.BoundingBox.Bottom - sw.BoundingBox.Bottom) < 10 &&
                w.BoundingBox.Right <= sw.BoundingBox.Left + 5);

            if (memberWord != null)
            {
                headerBottom = sw.BoundingBox.Bottom;
                tableLeft = Math.Min(memberWord.BoundingBox.Left, sw.BoundingBox.Left);
                break;
            }
        }

        if (headerBottom < 0) return [];

        // Extract words in the region below the header and within the schedule table width.
        // PDF Y-axis increases upward, so "below" = smaller Y value.
        var tableWords = pageWords.Where(w =>
            w.BoundingBox.Bottom < headerBottom &&
            w.BoundingBox.Bottom > headerBottom - 700 &&
            w.BoundingBox.Left >= tableLeft - 30 &&
            w.BoundingBox.Left <= tableLeft + 700)
            .ToList();

        return tableWords.Count > 0 ? ReconstructLines(tableWords) : [];
    }

    /// <summary>
    /// Returns up to 120 lines for the raw text preview, prioritising lines near
    /// schedule/footing sections so the user can verify the extracted text.
    /// </summary>
    private static List<string> BuildRawSample(List<string> allLines)
    {
        // Find the first schedule section index
        var schedIdx = -1;
        for (int i = 0; i < allLines.Count; i++)
        {
            var lower = allLines[i].ToLowerInvariant();
            if (ScheduleHeaders.Any(h => lower.Contains(h))
                || DrawingListSections.Any(s => lower.Contains(s.ToLower())))
            {
                schedIdx = i;
                break;
            }
        }

        var sample = new List<string>();

        if (schedIdx >= 0)
        {
            // 10 lines before the section + up to 110 lines from the section onward
            var from = Math.Max(0, schedIdx - 10);
            sample.AddRange(allLines.Skip(from).Take(120).Where(l => l.Length > 1));
        }

        // Fall back: lines that look like member marks or section sizes
        if (sample.Count < 20)
        {
            sample.AddRange(allLines
                .Where(l => l.Length > 3
                    && (Regex.IsMatch(l, @"\b[A-Z]{1,4}\d{1,3}\b")
                        || Regex.IsMatch(l, @"\b\d{2,4}\s*(UB|UC|PFC|RHS|SHS|CHS)\b", RegexOptions.IgnoreCase)
                        || Regex.IsMatch(l, @"\b\d{3,4}\s*[×xX]\s*\d{3,4}\b")))
                .Take(80));
        }

        return sample.Distinct().Take(120).ToList();
    }

    // ── Member parsing ───────────────────────────────────────────────────────────

    private List<ExtractedMemberDto> ParseMembers(List<string> lines, string fullText)
    {
        // Merge split mark tokens produced by CAD PDFs: "PF 2" → "PF2", "C 1" → "C1"
        var mergedLines = lines.Select(MergeMarkFragments).ToList();
        var mergedFullText = string.Join(" ", mergedLines);

        _logger.LogDebug("Extraction: {LineCount} lines after mark-fragment merge", mergedLines.Count);

        var results = new List<ExtractedMemberDto>();

        // COLUMNS / BEAMS lists on footing plans (SC2 - 360 UB 45, C1 - 610 UB 113)
        results.AddRange(ParseDrawingLists(mergedLines));
        _logger.LogDebug("After ParseDrawingLists: {Count} rows", results.Count);

        var scheduleStart = FindScheduleSection(mergedLines);
        if (scheduleStart >= 0)
            results.AddRange(ParseScheduleTable(mergedLines, scheduleStart));
        _logger.LogDebug("After ParseScheduleTable: {Count} rows", results.Count);

        results.AddRange(ParseByPattern(mergedLines, mergedFullText));
        _logger.LogDebug("After ParseByPattern: {Count} rows (pre-merge)", results.Count);

        // One row per mark — prefer drawing list > schedule > pattern
        results = MergePreferBestRows(results);

        var valid = results.Where(IsValidExtractedMember)
            .OrderBy(r => r.Mark, StringComparer.OrdinalIgnoreCase)
            .ToList();

        // Assign a unique palette color per mark (alphabetical order → stable color assignment)
        for (int i = 0; i < valid.Count; i++)
            valid[i] = valid[i] with { Color = ColorPalette[i % ColorPalette.Length] };

        var skipped = results.Where(r => !IsValidExtractedMember(r)).ToList();
        if (skipped.Count > 0)
        {
            _logger.LogInformation("Extraction: {Valid} valid, {Skipped} filtered. Skipped marks: {Marks}",
                valid.Count, skipped.Count,
                string.Join(", ", skipped.Select(r => $"{r.Mark}({r.Confidence:F2})")));
        }

        return valid;
    }

    /// <summary>
    /// Merges adjacent mark fragments produced by CAD PDF export.
    /// "PF 2" → "PF2",  "C 1" → "C1",  "SF 3" → "SF3".
    /// Only merges when result is a valid short structural mark (≤6 chars).
    /// </summary>
    private static string MergeMarkFragments(string line)
    {
        // Match letter prefix (1-4) + space + digit suffix (1-3 + optional letter)
        var merged = Regex.Replace(line,
            @"\b([A-Z]{1,4})\s+(\d{1,3}[A-Z]?)\b",
            m =>
            {
                var combined = m.Groups[1].Value + m.Groups[2].Value;
                if (combined.Length <= 6
                    && Regex.IsMatch(combined, @"^[A-Z]{1,4}\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase))
                    return combined;
                return m.Value;
            },
            RegexOptions.IgnoreCase);

        // Same CAD-export word-splitting artifact, but for a leading level/storey prefix:
        // "1 FB2" -> "1FB2" (the mark as printed on the drawing has no gap; PdfPig sometimes
        // reconstructs the level-number and the rest of the mark as separate words because
        // they're separate glyph runs in the PDF, even though they render with no visible gap).
        merged = Regex.Replace(merged,
            @"\b(\d{1,2})\s+([A-Z]{1,4}\d{1,3}[A-Z]?)\b",
            m =>
            {
                var combined = m.Groups[1].Value + m.Groups[2].Value;
                if (combined.Length <= 6)
                    return combined;
                return m.Value;
            },
            RegexOptions.IgnoreCase);

        return merged;
    }

    /// <summary>Only rows with a real PDF mark + section — drops note lines (PROVIDE, REINFORCEMENT, etc.).</summary>
    private static bool IsValidExtractedMember(ExtractedMemberDto r)
    {
        if (string.IsNullOrWhiteSpace(r.Mark) || string.IsNullOrWhiteSpace(r.MemberSize))
            return false;
        if (!Regex.IsMatch(r.Mark, "^" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?" + CompoundMarkSuffix + "$", RegexOptions.IgnoreCase))
            return false;
        // Auto-guess marks M1/M2 — not used on structural drawings
        if (Regex.IsMatch(r.Mark, @"^M\d+$", RegexOptions.IgnoreCase))
            return false;

        var desc = r.Description.ToUpperInvariant();
        if (Regex.IsMatch(desc, @"\b(PROVIDE|REINFORCEMENT|WELD\s+AT|WELD\s+ON|SLOTTED\s+HOLES)\b"))
            return false;

        return SteelSectionPattern.IsMatch(r.MemberSize)
            || HollowSectionPattern.IsMatch(r.MemberSize)
            || ReidBarPattern.IsMatch(r.MemberSize)
            || ConcreteDimPattern.IsMatch(r.MemberSize)
            || PurlinSectionPattern.IsMatch(r.MemberSize)
            || RodBracingPattern.IsMatch(r.MemberSize)
            || (r.Confidence >= 0.95 && r.MemberSize.Length >= 2);
    }

    /// <summary>
    /// Parses COLUMNS, BEAMS, PAD FOOTINGS blocks — "SC2 - 360 UB 45: REFER TO DETAIL..."
    /// </summary>
    private List<ExtractedMemberDto> ParseDrawingLists(List<string> lines)
    {
        var results = new List<ExtractedMemberDto>();
        bool inList = false;
        string? pendingMark = null;  // mark token whose spec was on the next line
        string? currentSection = null;

        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length < 2) continue;

            if (IsDrawingListHeader(line))
            {
                currentSection = line;
                inList = true;
                pendingMark = null;
                _logger.LogInformation("[Extract] Entered section: '{Section}'", line);
                continue;
            }

            if (inList && (IsStopLine(line) || IsDrawingListHeader(line)))
            {
                // A stop token like "LEGEND" can land glued onto a genuine member row when
                // unrelated columns on the same sheet (e.g. a legend box beside a pad-footings
                // list) share the same row height and get merged by Y-band ("LEGEND PF2 - 3500 x
                // 3500 x 600 DEEP..."). Salvage that row before closing the section, or the mark
                // silently vanishes at the exact line that should only end the list afterward.
                if (IsStopLine(line))
                {
                    var salvaged = TryParseDrawingListLine(line, allowLoose: true);
                    if (salvaged != null)
                    {
                        _logger.LogInformation("[Extract] Salvaged '{Mark}' ({Size}) from stop-line row '{Line}'",
                            salvaged.Mark, salvaged.MemberSize, line);
                        results.Add(salvaged);
                    }
                    _logger.LogInformation("[Extract] Section '{Section}' ended at stop line: '{Line}'", currentSection, line);
                }
                inList = false;
                pendingMark = null;
                if (IsDrawingListHeader(line)) { inList = true; currentSection = line; }
                continue;
            }

            ExtractedMemberDto? member = null;

            var splitMembers = TryParseSplitDrawingListLine(line);
            if (splitMembers.Count > 0)
            {
                foreach (var splitMember in splitMembers)
                {
                    _logger.LogInformation("[Extract] Parsed split-row '{Mark}' ({Size}) from section '{Section}'",
                        splitMember.Mark, splitMember.MemberSize, currentSection ?? "global");
                    results.Add(splitMember);
                }
                pendingMark = null;
                continue;
            }

            // When PDF text reconstruction splits "PF2" onto its own line, try to
            // join it with the following line which contains the dimensions.
            if (pendingMark != null)
            {
                var hasSpec = SteelSectionPattern.IsMatch(line)
                    || HollowSectionPattern.IsMatch(line)
                    || ConcreteDimPattern.IsMatch(line)
                    || ReidBarPattern.IsMatch(line);
                if (hasSpec)
                {
                    member = TryParseDrawingListLine($"{pendingMark} - {line}");
                }
                pendingMark = null;
                if (member == null && inList)
                    member = TryParseDrawingListLine(line, allowLoose: true);
            }
            else if (inList)
            {
                // Detect a standalone mark token — its spec may be on the next line
                var solo = Regex.Match(line, "^(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?)$", RegexOptions.IgnoreCase);
                if (solo.Success)
                {
                    pendingMark = solo.Groups[1].Value.ToUpperInvariant();
                    continue;
                }
                member = TryParseDrawingListLine(line, allowLoose: true);
            }
            else if (DrawingListLinePattern.IsMatch(line))
            {
                member = TryParseDrawingListLine(line);
            }

            if (member != null)
            {
                _logger.LogInformation("[Extract] Parsed '{Mark}' ({Size}) from section '{Section}'",
                    member.Mark, member.MemberSize, currentSection ?? "global");
                results.Add(member);
            }
            else if (inList && line.Length > 2)
            {
                _logger.LogInformation("[Extract] UNPARSED in '{Section}': '{Line}'",
                    currentSection ?? "?", line);
            }
        }

        return results;
    }

    private static bool IsDrawingListHeader(string line)
    {
        var upper = line.Trim().ToUpperInvariant();
        var compact = upper.Replace(" ", "");
        if (DrawingListSections.Any(s =>
        {
            var section = s.ToUpperInvariant();
            var sectionCompact = section.Replace(" ", "");
            return upper == section || upper.StartsWith(section + " ", StringComparison.Ordinal)
                || compact == sectionCompact || compact.StartsWith(sectionCompact, StringComparison.Ordinal);
        }))
            return true;

        // Same multi-column Y-band merging that glues an unrelated column's text onto a
        // member row (see DrawingListAnywherePattern) can just as easily glue it onto the
        // section header itself — "ENGINEER IF IN DOUBT. PAD FOOTINGS S4 - TILT-UP..." — which
        // defeats the StartsWith checks above and silently skips the entire section. Recognize
        // the header when it appears right after a sentence/column boundary (". ", ": ", "- ")
        // near the start of the line, rather than requiring it to BE the start of the line.
        return DrawingListSections.Any(s =>
        {
            var section = s.ToUpperInvariant();
            var match = Regex.Match(upper, @"(?:^|[.:\-]\s+)" + Regex.Escape(section) + @"\b");
            return match.Success && match.Index <= 40;
        });
    }

    private ExtractedMemberDto? TryParseDrawingListLine(string line, bool allowLoose = false)
    {
        var listMatch = DrawingListLinePattern.Match(line);
        if (!listMatch.Success && allowLoose)
            listMatch = DrawingListLoosePattern.Match(line);
        if (!listMatch.Success && allowLoose)
            listMatch = DrawingListAnywherePattern.Match(line);
        if (!listMatch.Success) return null;

        var mark = listMatch.Groups[1].Value.ToUpperInvariant();
        var rest = listMatch.Groups[2].Value.Trim();

        if (!Regex.IsMatch(mark, @"\d"))
        {
            var nested = DrawingListLinePattern.Match(rest);
            if (nested.Success && Regex.IsMatch(nested.Groups[1].Value, @"\d"))
            {
                mark = nested.Groups[1].Value.ToUpperInvariant();
                rest = nested.Groups[2].Value.Trim();
            }
        }

        // Drop trailing note after colon — "360 UB 45: REFER TO DETAIL..."
        var noteIdx = rest.IndexOf(':');
        if (noteIdx > 0) rest = rest[..noteIdx].Trim();

        var sectionMatch = SteelSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = PurlinSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = RodBracingPattern.Match(rest);
        if (sectionMatch.Success)
        {
            var sectionRaw = sectionMatch.Value.Trim();
            return new ExtractedMemberDto(
                mark, NormalizeSection(sectionRaw), DetectMemberType(mark, sectionRaw),
                0, 0, 0, TruncateLine(line), 0.95);
        }

        var reidMatch = ReidBarPattern.Match(rest);
        if (reidMatch.Success)
        {
            var reidSize = reidMatch.Groups[1].Value.ToUpperInvariant();
            return new ExtractedMemberDto(
                mark, reidSize, "Other",
                0, 0, 0, TruncateLine(line), 0.95);
        }

        // OR1, STR1, FJ1, etc. — keep specification text from the PDF list line
        var sizeLabel = Regex.Replace(rest, @"\s+", " ").Trim();
        if (sizeLabel.Length > 48) sizeLabel = sizeLabel[..48];
        if (sizeLabel.Length < 2) return null;

        return new ExtractedMemberDto(
            mark, sizeLabel, DetectMemberType(mark, sizeLabel),
            0, 0, 0, TruncateLine(line), 0.95);
    }

    private static List<ExtractedMemberDto> TryParseSplitDrawingListLine(string line)
    {
        var match = Regex.Match(line.Trim(),
            "^(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?)\s+(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?)\s*[-–—]\s*[-–—]\s*(.+)$",
            RegexOptions.IgnoreCase);
        if (!match.Success) return [];

        var mark1 = match.Groups[1].Value.ToUpperInvariant();
        var mark2 = match.Groups[2].Value.ToUpperInvariant();
        var rest = Regex.Replace(match.Groups[3].Value, @"\s+", " ");
        var rows = new List<ExtractedMemberDto>();

        void Add(string mark, string size)
        {
            var normalized = NormalizeSection(size);
            rows.Add(new ExtractedMemberDto(
                mark, normalized, DetectMemberType(mark, normalized),
                0, 0, 0, TruncateLine(line), 0.95));
        }

        var footing = Regex.Match(rest,
            @"^(\d{3,4})\s+(\d{3,4})\s*[xX×]\s*[xX×]\s*(\d{3,4})\s+(\d{3,4})\s*[xX×]\s*[xX×]\s*(\d{2,4})\s+(\d{2,4})\s+DEEP\b",
            RegexOptions.IgnoreCase);
        if (footing.Success)
        {
            Add(mark1, $"{footing.Groups[1].Value} x {footing.Groups[3].Value} x {footing.Groups[5].Value} DEEP");
            Add(mark2, $"{footing.Groups[2].Value} x {footing.Groups[4].Value} x {footing.Groups[6].Value} DEEP");
            return rows;
        }

        var mixedHollow = Regex.Match(rest,
            @"^(\d{2,4})\s+(\d{2,4})\s*[xX×]\s*[xX×]\s*(\d{1,2}(?:\.\d+)?)\s+(\d{2,4})\s+(SHS|RHS|CHS)\b.*?[xX×]\s*(\d{1,2}(?:\.\d+)?)\s+(RHS|SHS|CHS)\b",
            RegexOptions.IgnoreCase);
        if (mixedHollow.Success)
        {
            Add(mark1, $"{mixedHollow.Groups[1].Value} x {mixedHollow.Groups[3].Value} {mixedHollow.Groups[5].Value}");
            Add(mark2, $"{mixedHollow.Groups[2].Value} x {mixedHollow.Groups[4].Value} x {mixedHollow.Groups[6].Value} {mixedHollow.Groups[7].Value}");
            return rows;
        }

        var pairedHollow = Regex.Match(rest,
            @"^(\d{2,4})\s+(\d{2,4})\s*[xX×]\s*[xX×]\s*(\d{1,2}(?:\.\d+)?)\s+(\d{1,2}(?:\.\d+)?)\s+(SHS|RHS|CHS)\b",
            RegexOptions.IgnoreCase);
        if (pairedHollow.Success)
        {
            Add(mark1, $"{pairedHollow.Groups[1].Value} x {pairedHollow.Groups[3].Value} {pairedHollow.Groups[5].Value}");
            Add(mark2, $"{pairedHollow.Groups[2].Value} x {pairedHollow.Groups[4].Value} {pairedHollow.Groups[5].Value}");
            return rows;
        }

        var pairedSteel = Regex.Match(rest,
            @"^(\d{2,4})\s+(\d{2,4})\s+PFC\s+UB\s*(\d{1,3}(?:\.\d+)?)?\b",
            RegexOptions.IgnoreCase);
        if (pairedSteel.Success)
        {
            Add(mark1, $"{pairedSteel.Groups[1].Value} PFC");
            Add(mark2, $"{pairedSteel.Groups[2].Value} UB{pairedSteel.Groups[3].Value}");
            return rows;
        }

        return [];
    }

    private static List<ExtractedMemberDto> MergePreferBestRows(List<ExtractedMemberDto> rows)
    {
        var best = new Dictionary<string, ExtractedMemberDto>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows)
        {
            var key = row.Mark.Trim();
            if (string.IsNullOrEmpty(key)) continue;
            if (!best.TryGetValue(key, out var existing) || PreferExtractedRow(row, existing))
                best[key] = row;
        }
        return best.Values.ToList();
    }

    /// <summary>Drawing list (0.95) beats schedule (0.90) beats pattern (0.70).</summary>
    private static bool PreferExtractedRow(ExtractedMemberDto candidate, ExtractedMemberDto current)
    {
        if (candidate.Confidence > current.Confidence) return true;
        if (candidate.Confidence < current.Confidence) return false;

        var candPattern = IsPatternDescription(candidate.Description);
        var curPattern = IsPatternDescription(current.Description);
        if (curPattern && !candPattern) return true;
        if (!curPattern && candPattern) return false;

        return candidate.MemberSize.Length > current.MemberSize.Length;
    }

    private static bool IsPatternDescription(string description)
        => description.TrimStart().StartsWith("Pattern:", StringComparison.OrdinalIgnoreCase);

    private static int FindScheduleSection(List<string> lines)
    {
        for (int i = 0; i < lines.Count; i++)
        {
            var lower = lines[i].ToLowerInvariant();
            if (ScheduleHeaders.Any(h => lower.Contains(h)))
                return i;
        }
        return -1;
    }

    private List<ExtractedMemberDto> ParseScheduleTable(List<string> lines, int startIdx)
    {
        var results = new List<ExtractedMemberDto>();

        int headerIdx = startIdx;
        for (int i = startIdx; i < Math.Min(startIdx + 8, lines.Count); i++)
        {
            var lower = lines[i].ToLowerInvariant();
            if (lower.Contains("mark") || lower.Contains("size") || lower.Contains("section"))
            {
                headerIdx = i;
                break;
            }
        }

        string? pendingMark = null;
        for (int i = headerIdx + 1; i < lines.Count; i++)
        {
            var line = lines[i].Trim();
            if (line.Length < 2) { pendingMark = null; continue; }
            if (IsStopLine(line) && i > headerIdx + 3) break;
            if (IsSubHeader(line)) { pendingMark = null; continue; }

            // Two-line table format: mark appeared alone on the previous line.
            if (pendingMark != null)
            {
                var hasSpec = SteelSectionPattern.IsMatch(line) || HollowSectionPattern.IsMatch(line)
                           || ConcreteDimPattern.IsMatch(line) || ReidBarPattern.IsMatch(line);
                if (hasSpec)
                {
                    var combined = TryParseScheduleRow($"{pendingMark} - {line}");
                    if (combined != null) results.Add(combined);
                }
                pendingMark = null;
                // Don't skip — also try parsing this line on its own.
            }

            // Standalone mark token — description may be on the next line.
            var solo = Regex.Match(line, "^(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?" + CompoundMarkSuffix + @")$", RegexOptions.IgnoreCase);
            if (solo.Success)
            {
                pendingMark = solo.Groups[1].Value.ToUpperInvariant();
                continue;
            }

            var member = TryParseScheduleRow(line);
            if (member != null) { results.Add(member); pendingMark = null; }
        }

        return results;
    }

    private static bool IsStopLine(string line)
    {
        var lower = line.ToLowerInvariant();
        if (lower.StartsWith("note") || lower.StartsWith("general")
            || lower.StartsWith("drawing") || lower.StartsWith("detail"))
            return true;

        // Revision tables, legends, and generic notes sit right next to (or below) schedule
        // boxes on the same sheet — without this a schedule block can run straight into them
        // and pick up rows that are not structural members at all.
        if (RevisionRowPattern.IsMatch(line)) return true;
        if (lower.Contains("issued for") || lower.Contains("amendment") || lower.Contains("addendum"))
            return true;
        if (lower.StartsWith("legend") || lower.Contains("denotes"))
            return true;

        return false;
    }

    private static readonly HashSet<string> SubHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "RAFTERS","BEAMS","COLUMNS","PURLINS","GIRTS","BRACES",
            "FLOOR BEAMS","FLOORBEAMS","ROOF BEAMS","PORTAL FRAMES",
            "SECONDARY MEMBERS","OTHERS","OTHER",
            "FASCIA BEAM","WALL STIFFENERS","RAKING ANGLES","STRUTS",
            "ROOF BRACING","PARAPET","STUB COLUMNS",
        };

    private static bool IsSubHeader(string line) => SubHeaders.Contains(line.Trim());

    private ExtractedMemberDto? TryParseScheduleRow(string line)
    {
        var sectionMatch = SteelSectionPattern.Match(line);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(line);
        if (!sectionMatch.Success) sectionMatch = PurlinSectionPattern.Match(line);
        if (!sectionMatch.Success) sectionMatch = RodBracingPattern.Match(line);

        if (sectionMatch.Success)
        {
            var sectionRaw = sectionMatch.Value.Trim();
            var mark = ExtractPdfMark(line, sectionMatch) ?? NormalizeSection(sectionRaw);
            var memberType = DetectScheduleMemberType(mark, line);
            return new ExtractedMemberDto(
                mark, NormalizeSection(sectionRaw), memberType,
                0, 0, 0, $"Schedule: {TruncateLine(line)}", 0.90);
        }

        // PAD FOOTINGS use dimension format: "PF2 - 1200 × 1200 × 300 DEEP"
        var concreteMatch = ConcreteDimPattern.Match(line);
        if (concreteMatch.Success)
        {
            var dimRaw = concreteMatch.Value.Trim();
            var mark = ExtractPdfMark(line, concreteMatch);
            if (!string.IsNullOrEmpty(mark))
            {
                return new ExtractedMemberDto(
                    mark, dimRaw, DetectScheduleMemberType(mark, line),
                    0, 0, 0, $"Schedule: {TruncateLine(line)}", 0.90);
            }
        }

        var generic = TryParseGenericScheduleRow(line);
        if (generic != null) return generic;

        return null;
    }

    private ExtractedMemberDto? TryParseGenericScheduleRow(string line)
    {
        if (IsMetadataLine(line)) return null;

        var cleaned = MergeMarkFragments(Regex.Replace(line.Trim(), @"\s+", " "));
        cleaned = Regex.Replace(cleaned, @"^[|:\-–—\s]+", "");

        // The optional non-captured `\d{1,3}\s+` prefix is a separate "ITEM" row-number column
        // some schedule tables have before the mark (e.g. "1  FB1  410UB53.7"); MarkPrefix inside
        // the capture group instead handles a level prefix directly attached to the mark itself
        // with no space (e.g. "1FB1  410UB53.7") — both can appear, independently of each other.
        var match = Regex.Match(cleaned,
            @"^(?:\d{1,3}\s+)?(" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?)\s+(.{2,})$",
            RegexOptions.IgnoreCase);
        if (!match.Success) return null;

        var mark = match.Groups[1].Value.ToUpperInvariant();
        if (!IsLikelyScheduleMark(mark)) return null;

        var rest = match.Groups[2].Value.Trim();
        if (rest.Length < 2 || IsMetadataLine(rest)) return null;

        var section = ExtractGenericScheduleSection(rest);
        if (string.IsNullOrWhiteSpace(section)) return null;

        var memberType = DetectScheduleMemberType(mark, rest);
        return new ExtractedMemberDto(
            mark, section, memberType,
            0, 0, 0, $"Schedule: {TruncateLine(cleaned)}", 0.96);
    }

    private static bool IsLikelyScheduleMark(string mark)
    {
        if (!Regex.IsMatch(mark, "^" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase))
            return false;

        var upper = mark.ToUpperInvariant();
        if (Regex.IsMatch(upper, @"^(UNIT|DATE|DWG|REV|SCALE|SHEET|TENDER|NOTE)\d*$"))
            return false;

        // Strip a leading level/storey prefix (e.g. "1FB1" -> "FB1") before checking against the
        // known prefix-letter list below, which only knows about the letter part of the mark.
        var withoutLevelPrefix = Regex.Replace(upper, "^" + MarkPrefix, "");
        return Regex.IsMatch(withoutLevelPrefix,
            @"^(EC|CC|DP|DB|HB|WB|DF|PF|SF|RW|CJ|SB|FAB|FB|RBR|RB|RA|WS|PB|ST|R|P|S|C|B|W)\d",
            RegexOptions.IgnoreCase);
    }

    private static string ExtractGenericScheduleSection(string rest)
    {
        var sectionMatch = SteelSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = PurlinSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = RodBracingPattern.Match(rest);
        if (sectionMatch.Success) return NormalizeSection(sectionMatch.Value.Trim());

        var concreteMatch = ConcreteDimPattern.Match(rest);
        if (concreteMatch.Success) return concreteMatch.Value.Trim();

        var typeMatch = Regex.Match(rest,
            @"\b(COLUMN|COL|WALL|BEAM|HEADER|HOB|DOOR|FRAME|FOOTING|SLAB|BRACE|BLOCKWORK)\b",
            RegexOptions.IgnoreCase);

        var section = typeMatch.Success && typeMatch.Index > 0
            ? rest[..typeMatch.Index].Trim()
            : string.Join(" ", rest.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(4));

        section = Regex.Replace(section, @"\s+", " ").Trim(' ', '-', '–', '—', '|', ':');
        return section.Length > 48 ? section[..48] : section;
    }

    private static string DetectScheduleMemberType(string mark, string rowText)
    {
        var m = mark.ToUpperInvariant();
        var row = rowText.ToUpperInvariant();

        if (m.StartsWith("C")) return "Column";
        if (m.StartsWith("HB")) return "Beam";
        if (m.StartsWith("WB")) return "Beam";
        if (m.StartsWith("DF")) return "Other";
        if (row.Contains("WALL")) return "Wall";
        if (row.Contains("COLUMN") || row.Contains(" COL")) return "Column";
        if (row.Contains("BEAM") || row.Contains("HEADER")) return "Beam";
        if (row.Contains("FOOTING")) return "Footing";
        return DetectMemberType(mark, rowText);
    }

    private List<ExtractedMemberDto> ParseByPattern(List<string> lines, string fullText)
    {
        var results = new List<ExtractedMemberDto>();

        foreach (var line in lines)
        {
            if (IsSubHeader(line)) continue;
            // Already parsed as drawing-list row (SC2 - 360 UB 45)
            if (DrawingListLinePattern.IsMatch(line.Trim())) continue;

            foreach (Match sm in SteelSectionPattern.Matches(line))
            {
                if (IsNoisePatternLine(line, sm)) continue;
                TryAddPatternRow(results, line, sm);
            }

            foreach (Match hm in HollowSectionPattern.Matches(line))
            {
                if (IsNoisePatternLine(line, hm)) continue;
                TryAddPatternRow(results, line, hm);
            }

            foreach (Match pm in PurlinSectionPattern.Matches(line))
            {
                if (IsNoisePatternLine(line, pm)) continue;
                TryAddPatternRow(results, line, pm);
            }

            foreach (Match rm in RodBracingPattern.Matches(line))
            {
                if (IsNoisePatternLine(line, rm)) continue;
                TryAddPatternRow(results, line, rm);
            }

            var reidMatch = ReidBarPattern.Match(line);
            if (reidMatch.Success && !IsNoisePatternLine(line, reidMatch))
            {
                var mark = ExtractPdfMark(line, reidMatch) ?? reidMatch.Groups[1].Value.ToUpperInvariant();
                results.Add(new ExtractedMemberDto(
                    mark, reidMatch.Groups[1].Value.ToUpperInvariant(), "Other",
                    0, 0, 0, $"Pattern: {TruncateLine(line)}", 0.70));
            }

            // PAD FOOTINGS / concrete members — "PF2 - 1200 × 1200 × 300 DEEP"
            // Only when no steel section found and a valid mark precedes the dimension.
            if (!SteelSectionPattern.IsMatch(line) && !HollowSectionPattern.IsMatch(line))
            {
                foreach (Match cdm in ConcreteDimPattern.Matches(line))
                {
                    if (IsNoisePatternLine(line, cdm)) continue;
                    var mark = ExtractPdfMark(line, cdm);
                    if (string.IsNullOrEmpty(mark)) continue;
                    results.Add(new ExtractedMemberDto(
                        mark, cdm.Value.Trim(), DetectMemberType(mark, cdm.Value),
                        0, 0, 0, $"Pattern: {TruncateLine(line)}", 0.70));
                }
            }
        }

        return results;
    }

    private void TryAddPatternRow(List<ExtractedMemberDto> results, string line, Match sm)
    {
        var sectionRaw = sm.Value.Trim();
        var mark = ExtractPdfMark(line, sm) ?? NormalizeSection(sectionRaw);
        var memberType = DetectMemberType(mark, sectionRaw);

        results.Add(new ExtractedMemberDto(
            mark, NormalizeSection(sectionRaw), memberType,
            0, 0, 0,
            $"Pattern: {TruncateLine(line)}",
            0.70
        ));
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Reads member mark exactly as written on the drawing (e.g. SC2, B1, C7) — never auto M1/M2.
    /// </summary>
    private static string? ExtractPdfMark(string line, Match sectionMatch)
    {
        // Compound sub-element marks in schedule tables — "2T1.EV 400WC270 STEEL END VERTICAL",
        // "2T1-BC 400WC270 STEEL BOTTOM CHORD". Checked first, against just the isolated
        // mark-column text (everything before the already-confirmed size/section match), so a
        // compound mark at the very start of a row can never be misread by `leading` below as
        // "mark - description" (truncating "2T1-BC" to "2T1"). Anchored at the END ($) only, not
        // the start, so it can skip past leading junk from multi-column row reconstruction (e.g.
        // "9 2T1.D", "2 F.R.L AS REQUIRED BY THE BUILDING SURVEYOR. 2T1.EV") the same way the
        // plain-mark fallback further below already does — the compound suffix is purely additive,
        // so a plain mark like "SC2" or "1FB1" here resolves identically either way.
        if (sectionMatch.Index > 0)
        {
            var beforeCompound = line[..sectionMatch.Index].Trim();
            var compoundMark = Regex.Match(beforeCompound,
                "(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?" + CompoundMarkSuffix + @")\s*[-–—]?\s*$",
                RegexOptions.IgnoreCase);
            if (compoundMark.Success) return compoundMark.Groups[1].Value.ToUpperInvariant();
        }

        // COLUMNS list: "SC2 - 360 UB 45" / "C1 - 610 UB 113" / "1FB1 - 410UB53.7"
        var leading = Regex.Match(line.Trim(),
            "^(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:]\s*",
            RegexOptions.IgnoreCase);
        if (leading.Success) return leading.Groups[1].Value.ToUpperInvariant();

        var tableMark = TableRowMarkPattern.Match(line);
        if (tableMark.Success) return tableMark.Groups[1].Value.ToUpperInvariant();

        var schedMark = PdfScheduleMarkPattern.Match(line);
        if (schedMark.Success) return schedMark.Groups[1].Value.ToUpperInvariant();

        var labelMark = Regex.Match(line,
            @"(?:Schedule|Pattern|SCHEDULE|PATTERN)\s*:\s*(" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—]",
            RegexOptions.IgnoreCase);
        if (labelMark.Success) return labelMark.Groups[1].Value.ToUpperInvariant();

        if (sectionMatch.Index > 0)
        {
            // Already covered by the compound-mark check above (same pattern, minus the compound
            // suffix, which is a strict superset) — kept only for the token-split fallback below.
            var before = line[..sectionMatch.Index].Trim();
            var tokens = before.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length > 0)
            {
                var last = tokens[^1].Trim().TrimEnd('-', '–', '—');
                if (Regex.IsMatch(last, "^" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?$", RegexOptions.IgnoreCase))
                    return last.ToUpperInvariant();
            }
        }

        // B1, C7 only — not M1 auto-fallback (exclude M to avoid false matches)
        var memberMark = Regex.Match(line, @"(?<![A-Z])([BCPRGFHK]\d{1,2})\b");
        if (memberMark.Success && memberMark.Index < sectionMatch.Index)
            return memberMark.Groups[1].Value.ToUpperInvariant();

        return null;
    }

    // Revision/amendment table rows — "0 ISSUED FOR TENDER 12.03.26 J.V.", "T1 TENDER ADDENDUM ..."
    private static readonly Regex RevisionRowPattern = new(
        @"^\s*[A-Z0-9]{1,3}\s+(ISSUED|REVISION|AMENDMENT|ADDENDUM|REVIEW|COORDINATION|CONSTRUCTION)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static bool IsNoisePatternLine(string line, Match sectionMatch)
    {
        var upper = line.ToUpperInvariant();
        if (upper.Contains("REINFORCEMENT")) return true;
        if (Regex.IsMatch(upper, @"\bPROVIDE\b")) return true;
        if (upper.Contains("WELD AT") || upper.Contains("WELD ON")) return true;
        if (upper.Contains("GENERAL NOTE") || upper.StartsWith("NOTE ")) return true;

        // Revision/amendment history rows — never structural members, but can superficially
        // contain digit runs (dates, rev numbers) that trip the dimension/section regexes.
        if (RevisionRowPattern.IsMatch(line)) return true;
        if (upper.Contains("ISSUED FOR") || upper.Contains("AMENDMENT") || upper.Contains("ADDENDUM")) return true;

        // Legends and generic drawing notes ("DENOTES...", "REFER TO...", "TYPICAL", scale/NTS
        // callouts) — descriptive text, not schedule entries, even when it mentions a size.
        if (upper.Contains("DENOTES") || upper.Contains("LEGEND")) return true;
        if (upper.Contains("REFER TO") || upper.Contains("REFER ARCH") || upper.Contains("REFER ENG")) return true;
        if (upper.Contains("TYPICAL") || upper.Contains("UNLESS NOTED OTHERWISE") || upper == "UNO") return true;
        if (upper.Contains("N.T.S") || upper.Contains("NOT TO SCALE") || upper.Contains("DO NOT SCALE")) return true;

        return false;
    }

    private static string DetectMemberType(string mark, string section)
    {
        var m = mark.ToUpperInvariant();
        var s = section.ToUpperInvariant();
        if (m.StartsWith("SC") || m.StartsWith("MC")) return "Column";
        if (m.StartsWith("FB") || m.StartsWith("WB")) return "Beam";
        if (m.StartsWith("RB") || m.StartsWith("RF")) return "Rafter";
        if (m.StartsWith("B") && !m.StartsWith("BF")) return "Beam";
        if (m.StartsWith("C") && !s.StartsWith("CHS")) return "Column";
        if (m.StartsWith("R") && ReidBarPattern.IsMatch(section)) return "Other";
        if (m.StartsWith("R") || m.StartsWith("F")) return "Rafter";
        if (m.StartsWith("P") || s.Contains("PFC")) return "Purlin";
        if (m.StartsWith("G")) return "Girt";
        if (m.StartsWith("K") || m.StartsWith("H")) return "Brace";
        if (s.Contains("RHS") || s.Contains("SHS") || s.Contains("CHS")) return "Brace";
        if (s.Contains("EA") || s.Contains("UA")) return "Angle";
        if (s.Contains("UB")) return "Beam";
        if (s.Contains("UC")) return "Column";
        return "Other";
    }

    private static string NormalizeSection(string raw)
    {
        var trimmed = raw.Trim();

        // "75 x 5 SHS" / "150 x 150 x 6 SHS" / "150 x 10 EA"
        var hollow = Regex.Match(trimmed,
            @"^(\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*[xX×]\s*(\d{1,2}(?:\.\d+)?))?\s*(RHS|SHS|CHS|EA|UA)$",
            RegexOptions.IgnoreCase);
        if (hollow.Success)
        {
            var wall = hollow.Groups[3].Success ? $"X{hollow.Groups[3].Value}" : "";
            return $"{hollow.Groups[1].Value}X{hollow.Groups[2].Value}{wall}{hollow.Groups[4].Value}".ToUpperInvariant();
        }

        // "360 UB 45" → "360UB45" so weight suffix is preserved from PDF
        var spaced = Regex.Match(trimmed,
            @"^(\d{2,4})\s*(UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS|WB|WC)\s+(\d{1,3}(?:\.\d+)?)$",
            RegexOptions.IgnoreCase);
        if (spaced.Success)
            return $"{spaced.Groups[1].Value}{spaced.Groups[2].Value}{spaced.Groups[3].Value}".ToUpperInvariant();
        return Regex.Replace(trimmed, @"\s+", "").ToUpperInvariant();
    }

    private static string TruncateLine(string line)
        => line.Length > 60 ? line[..60] + "..." : line;
}
