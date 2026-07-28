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
            var variantScheduleMembers = new List<ExtractedMemberDto>();
            var columnScheduleMembers = new List<ExtractedMemberDto>();
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
                    // Some steel-member reference schedules use one base mark per row and
                    // lettered variant columns (MARK, a, b, c...). Preserve every populated
                    // table cell as its full mark (for example B015A, B015B, B015C).
                    variantScheduleMembers.AddRange(ExtractVariantScheduleCells(words));
                    // Conventional MARK/SIZE and ITEM/MEMBER schedule columns can also be
                    // resolved by coordinates without mixing them with plan annotations.
                    columnScheduleMembers.AddRange(ExtractColumnScheduleRows(words));
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
            var members = ParseMembers(
                allLines, fullText, variantScheduleMembers, columnScheduleMembers);

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
                    members = ParseMembers(
                        allLines, fullText, variantScheduleMembers, columnScheduleMembers);
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

            var detectedTableRows = ExtractDynamicScheduleTableLines(engine, bitmap);
            if (detectedTableRows.Count >= 3)
            {
                _logger.LogInformation(
                    "Schedule OCR page {Page}: dynamically detected {Rows} schedule line(s): {Sample}",
                    pageCount, detectedTableRows.Count,
                    string.Join(" | ", detectedTableRows.Take(40)));
                lines.Add("MEMBER SCHEDULE ITEM MEMBER SECTION TYPE DESCRIPTION");
                lines.AddRange(detectedTableRows);
                bitmap.Dispose();
                continue;
            }

            var gridRows = ExtractGridScheduleRows(engine, bitmap);
            if (ScoreScheduleOcrLines(gridRows) >= 5)
            {
                _logger.LogInformation(
                    "Schedule OCR page {Page}: row-level grid OCR returned {Rows} line(s)",
                    pageCount, gridRows.Count);
                lines.Add("MEMBER SCHEDULE ITEM MEMBER SECTION TYPE DESCRIPTION");
                lines.AddRange(gridRows);
                bitmap.Dispose();
                continue;
            }

            var scoredCandidates = new List<(int Score, List<string> Lines)>();

            foreach (var crop in BuildTargetedScheduleCrops(bitmap.Width, bitmap.Height))
            {
                var cropLines = OcrScheduleTableRegion(engine, bitmap, crop);
                var score = ScoreScheduleOcrLines(cropLines);
                if (score > 0 && cropLines.Count > 0)
                    scoredCandidates.Add((score, cropLines));
            }

            if (scoredCandidates.Count > 0)
            {
                var selected = scoredCandidates
                    .OrderByDescending(c => c.Score)
                    .Take(3)
                    .ToList();

                _logger.LogInformation(
                    "Schedule OCR page {Page}: selected {Candidates} candidate(s), best score={Score}",
                    pageCount, selected.Count, selected[0].Score);

                lines.Add("MEMBER SCHEDULE ITEM MEMBER SECTION TYPE DESCRIPTION");
                lines.AddRange(selected
                    .SelectMany(c => c.Lines)
                    .Distinct(StringComparer.OrdinalIgnoreCase));
            }

            bitmap.Dispose();
        }

        return lines;
    }

    private sealed record OcrPositionedWord(
        string Text, int Left, int Top, int Right, int Bottom)
    {
        public int CenterX => (Left + Right) / 2;
        public int CenterY => (Top + Bottom) / 2;
        public int Height => Math.Max(1, Bottom - Top);
    }

    private List<string> ExtractDynamicScheduleTableLines(
        TesseractEngine engine,
        SKBitmap source)
    {
        const int locatorWidth = 4600;
        var scale = Math.Min(1.0, locatorWidth / (double)source.Width);
        var locatorHeight = Math.Max(1, (int)Math.Round(source.Height * scale));
        using var locator = new SKBitmap(
            Math.Max(1, (int)Math.Round(source.Width * scale)), locatorHeight);
        using (var canvas = new SKCanvas(locator))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, new SKRect(0, 0, locator.Width, locator.Height));
        }

        var locatorWords = OcrPositionedWords(engine, locator, PageSegMode.SparseText);
        var headers = FindMemberScheduleHeaders(locatorWords);
        _logger.LogInformation(
            "Dynamic schedule locator: {Words} word(s), {Headers} header(s), signals={Signals}",
            locatorWords.Count,
            headers.Count,
            string.Join(" | ", locatorWords
                .Where(w => w.Text.Contains("MEM", StringComparison.OrdinalIgnoreCase)
                    || w.Text.Contains("SCH", StringComparison.OrdinalIgnoreCase))
                .Take(20)
                .Select(w => w.Text)));
        if (headers.Count == 0) return [];

        var result = new List<string>();
        foreach (var header in headers)
        {
            var (left, right) = FindScheduleHorizontalBounds(locator, header);
            if (right - left < header.Right - header.Left) continue;

            var bottom = FindScheduleBottom(locator, left, right, header.Bottom);
            if (bottom <= header.Bottom + (header.Height * 3))
                bottom = Math.Min(locator.Height, header.Bottom + (int)(locator.Height * 0.48));

            var inverseScale = 1.0 / scale;
            var crop = new SKRectI(
                Math.Clamp((int)Math.Floor(left * inverseScale), 0, source.Width - 1),
                Math.Clamp((int)Math.Floor(Math.Max(0, header.Top - header.Height) * inverseScale), 0, source.Height - 1),
                Math.Clamp((int)Math.Ceiling(right * inverseScale), 1, source.Width),
                Math.Clamp((int)Math.Ceiling(bottom * inverseScale), 1, source.Height));
            if (crop.Width < 80 || crop.Height < 80) continue;

            using var table = new SKBitmap(crop.Width, crop.Height);
            using (var canvas = new SKCanvas(table))
            {
                canvas.Clear(SKColors.White);
                canvas.DrawBitmap(source, crop, new SKRect(0, 0, table.Width, table.Height));
            }

            var columnRows = ExtractScheduleColumnRows(engine, table);
            if (ScoreScheduleOcrLines(columnRows) >= 5)
            {
                result.AddRange(columnRows);
                continue;
            }

            var tableWords = OcrPositionedWords(engine, table, PageSegMode.SparseText);
            result.AddRange(ReconstructOcrScheduleRows(tableWords, table.Height));
        }

        return NormalizeDynamicScheduleRows(result)
            .Select(l => NormalizeScheduleOcrLine(Regex.Replace(l.Trim(), @"\s+", " ")))
            .Where(l => l.Length > 1 && !IsMetadataLine(l))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<string> NormalizeDynamicScheduleRows(List<string> rows)
    {
        var normalized = RecoverSequentialScheduleRows(rows)
            .Select(row => Regex.Replace(row, @"^\$(?=\d+\s)", "S"))
            .Select(row => Regex.Replace(row, @"^\(?1(?=\s+\d)", "C1", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(row, @"^C[Ii][Xx](?=\s)", "C1X", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(
                row,
                @"^S\(?1(?=\s)",
                row.Contains("STUB COLUMN", StringComparison.OrdinalIgnoreCase) ? "SC1" : "S1",
                RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(row, @"^([A-Z]{1,3})[Ii](?=\s+\d)", "${1}1", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(row, @"^(CB)S(?=\s+\d)", "${1}5", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(row, @"^(B)T(?=\s+\d)", "${1}7", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(row, @"^3(?=\s+89\s+SHS)", "C3", RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(
                row,
                @"^([A-Z]{1,4}\d{1,3}[A-Z]?)[&|]\s+",
                "$1 - ",
                RegexOptions.IgnoreCase))
            .Select(row => Regex.Replace(
                row,
                @"^([A-Z]{2,})(?:\s*[-–—]\s*|\s+)([A-Z]\d+)\s+(.+)$",
                "$2 - $1 $3",
                RegexOptions.IgnoreCase))
            .ToList();

        // A top cell border can be read as a trailing "4" on the first numbered mark
        // (R1 -> R14, P1 -> P14). Correct it only when the same detected table contains
        // the corresponding prefix-2 row and does not contain an explicit prefix-1 row.
        for (var i = 0; i < normalized.Count; i++)
        {
            var match = Regex.Match(normalized[i], @"^([A-Z]{1,4})14(\s+.+)$",
                RegexOptions.IgnoreCase);
            if (!match.Success) continue;
            var prefix = match.Groups[1].Value;
            var hasSecond = normalized.Any(row =>
                Regex.IsMatch(row, $"^{Regex.Escape(prefix)}2\\s",
                    RegexOptions.IgnoreCase));
            var hasFirst = normalized.Any(row =>
                Regex.IsMatch(row, $"^{Regex.Escape(prefix)}1\\s",
                    RegexOptions.IgnoreCase));
            if (hasSecond && !hasFirst)
                normalized[i] = $"{prefix}1{match.Groups[2].Value}";
        }

        return normalized.Select(row =>
        {
            var match = Regex.Match(row,
                @"^([A-Z]{1,4}\d{0,3}[A-Z]?)\s+(.+)$",
                RegexOptions.IgnoreCase);
            if (!match.Success) return row;
            var remainder = match.Groups[2].Value;
            var hasMemberSignal = SteelSectionPattern.IsMatch(remainder)
                || HollowSectionPattern.IsMatch(remainder)
                || PurlinSectionPattern.IsMatch(remainder)
                || RodBracingPattern.IsMatch(remainder)
                || Regex.IsMatch(remainder,
                    @"^(?:\d+\s*/\s*)?\d|EXISTING|FASCIA|REFER",
                    RegexOptions.IgnoreCase);
            return hasMemberSignal
                ? $"{match.Groups[1].Value} - {remainder}"
                : row;
        }).ToList();
    }

    private static List<string> RecoverSequentialScheduleRows(List<string> rows)
    {
        var repaired = rows.ToList();
        for (var i = 0; i + 3 < repaired.Count; i++)
        {
            var baseDescription = repaired[i].Trim();
            var noisyStandaloneMark = repaired[i + 1].Trim();
            var firstDescription = repaired[i + 2].Trim();
            var secondMark = Regex.Match(repaired[i + 3],
                @"^([A-Z]{1,4})2(?:\s|[-:])",
                RegexOptions.IgnoreCase);

            var standalone = Regex.IsMatch(noisyStandaloneMark, @"^[A-Z0-9()$]{1,5}$",
                RegexOptions.IgnoreCase);
            var firstHasSection = SteelSectionPattern.IsMatch(firstDescription)
                || HollowSectionPattern.IsMatch(firstDescription)
                || PurlinSectionPattern.IsMatch(firstDescription)
                || RodBracingPattern.IsMatch(firstDescription);
            var baseHasNoMark = !Regex.IsMatch(baseDescription,
                @"^[A-Z]{1,4}\d{0,3}[A-Z]?\s*[-:]",
                RegexOptions.IgnoreCase);

            if (!standalone || !firstHasSection || !baseHasNoMark || !secondMark.Success)
                continue;

            var prefix = secondMark.Groups[1].Value.ToUpperInvariant();
            repaired[i] = $"{prefix} {baseDescription}";
            repaired[i + 1] = $"{prefix}1 {firstDescription}";
            repaired.RemoveAt(i + 2);
        }
        return repaired;
    }

    private static int CountLikelyPairedScheduleRows(List<string> rows)
        => rows.Count(row =>
        {
            var match = Regex.Match(row,
                @"^[A-Z]{1,4}\d{1,3}[A-Z]?\s+(.+)$",
                RegexOptions.IgnoreCase);
            if (!match.Success) return false;
            var member = match.Groups[1].Value;
            return SteelSectionPattern.IsMatch(member)
                || HollowSectionPattern.IsMatch(member)
                || PurlinSectionPattern.IsMatch(member)
                || RodBracingPattern.IsMatch(member);
        });

    private static List<OcrPositionedWord> OcrPositionedWords(
        TesseractEngine engine,
        SKBitmap bitmap,
        PageSegMode mode)
    {
        using var pngData = bitmap.Encode(SKEncodedImageFormat.Png, 100);
        using var pix = Pix.LoadFromMemory(pngData.ToArray());
        using var page = engine.Process(pix, mode);
        using var iterator = page.GetIterator();

        var words = new List<OcrPositionedWord>();
        iterator.Begin();
        do
        {
            var text = iterator.GetText(PageIteratorLevel.Word)?.Trim();
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (!iterator.TryGetBoundingBox(PageIteratorLevel.Word, out var box)) continue;
            words.Add(new OcrPositionedWord(
                text, box.X1, box.Y1, box.X2, box.Y2));
        }
        while (iterator.Next(PageIteratorLevel.Word));

        return words;
    }

    private static List<string> ExtractScheduleColumnRows(
        TesseractEngine engine,
        SKBitmap table)
    {
        var verticals = DetectVerticalRuleCenters(table);
        if (verticals.Count < 3) return [];

        // The first two schedule columns are consistently MARK/ITEM and SIZE/MEMBER.
        // Additional comments columns are deliberately left out of member identification.
        var markRect = new SKRectI(
            verticals[0] + 12, 0, verticals[1] - 12, table.Height);
        var sizeRect = new SKRectI(
            verticals[1] + 12, 0, verticals[2] - 12, table.Height);
        if (markRect.Width < 25 || sizeRect.Width < 40) return [];

        using var markColumn = CopyBitmapRegion(table, markRect);
        using var sizeColumn = CopyBitmapRegion(table, sizeRect);
        RemoveLongLineRuns(markColumn);
        RemoveLongLineRuns(sizeColumn);

        var marks = GroupOcrWordsByLine(
            OcrPositionedWords(engine, markColumn, PageSegMode.SparseText));
        var sizes = GroupOcrWordsByLine(
            OcrPositionedWords(engine, sizeColumn, PageSegMode.SparseText));
        if (marks.Count == 0 || sizes.Count == 0) return [];

        var tolerance = Math.Max(18, table.Height / 180);
        var rows = new List<string>();
        foreach (var mark in marks)
        {
            var size = sizes
                .Where(s => Math.Abs(s.CenterY - mark.CenterY) <= tolerance)
                .OrderBy(s => Math.Abs(s.CenterY - mark.CenterY))
                .FirstOrDefault();
            if (size == null) continue;
            rows.Add($"{mark.Text} {size.Text}");
        }
        return rows;
    }

    private sealed record OcrLine(int CenterY, string Text);

    private static List<OcrLine> GroupOcrWordsByLine(List<OcrPositionedWord> words)
    {
        if (words.Count == 0) return [];
        var medianHeight = words.Select(w => w.Height).OrderBy(h => h)
            .ElementAt(words.Count / 2);
        var tolerance = Math.Max(5, (int)Math.Round(medianHeight * 0.75));
        var groups = new List<List<OcrPositionedWord>>();

        foreach (var word in words.OrderBy(w => w.CenterY).ThenBy(w => w.Left))
        {
            var group = groups.LastOrDefault(g =>
                Math.Abs(g.Average(x => x.CenterY) - word.CenterY) <= tolerance);
            if (group == null)
            {
                group = [];
                groups.Add(group);
            }
            group.Add(word);
        }

        return groups.Select(g => new OcrLine(
                (int)Math.Round(g.Average(w => w.CenterY)),
                string.Join(" ", g.OrderBy(w => w.Left).Select(w => w.Text))))
            .ToList();
    }

    private static List<int> DetectVerticalRuleCenters(SKBitmap bitmap)
    {
        var hits = new List<int>();
        var threshold = Math.Max(80, (int)(bitmap.Height * 0.30));
        for (var x = 0; x < bitmap.Width; x++)
        {
            var dark = 0;
            for (var y = 0; y < bitmap.Height; y++)
            {
                var c = bitmap.GetPixel(x, y);
                if (((c.Red * 299) + (c.Green * 587) + (c.Blue * 114)) < 120000)
                    dark++;
            }
            if (dark >= threshold) hits.Add(x);
        }
        if (hits.Count == 0) return [];

        var centers = new List<int>();
        var start = hits[0];
        var end = hits[0];
        foreach (var x in hits.Skip(1))
        {
            if (x <= end + 2)
            {
                end = x;
                continue;
            }
            centers.Add((start + end) / 2);
            start = end = x;
        }
        centers.Add((start + end) / 2);
        return centers;
    }

    private static SKBitmap CopyBitmapRegion(SKBitmap source, SKRectI crop)
    {
        var copy = new SKBitmap(crop.Width, crop.Height);
        using var canvas = new SKCanvas(copy);
        canvas.Clear(SKColors.White);
        canvas.DrawBitmap(source, crop, new SKRect(0, 0, copy.Width, copy.Height));
        return copy;
    }

    private static List<OcrPositionedWord> FindMemberScheduleHeaders(
        List<OcrPositionedWord> words)
    {
        var headers = new List<OcrPositionedWord>();
        foreach (var member in words.Where(w =>
                     Regex.IsMatch(w.Text, @"^MEMB(?:ER|FR)$", RegexOptions.IgnoreCase)))
        {
            var schedule = words
                .Where(w => Regex.IsMatch(w.Text, @"^SCHED(?:ULE|UIE)$", RegexOptions.IgnoreCase))
                .Where(w => Math.Abs(w.CenterY - member.CenterY)
                    <= Math.Max(member.Height, w.Height) * 2)
                .Where(w => w.Left >= member.Left
                    && w.Left - member.Right < member.Height * 15)
                .OrderBy(w => w.Left)
                .FirstOrDefault();
            if (schedule == null) continue;

            var combined = new OcrPositionedWord(
                "MEMBER SCHEDULE",
                Math.Min(member.Left, schedule.Left),
                Math.Min(member.Top, schedule.Top),
                Math.Max(member.Right, schedule.Right),
                Math.Max(member.Bottom, schedule.Bottom));
            if (!headers.Any(h => Math.Abs(h.CenterX - combined.CenterX) < combined.Height * 4))
                headers.Add(combined);
        }
        return headers;
    }

    private static (int Left, int Right) FindScheduleVerticalBounds(
        SKBitmap bitmap,
        OcrPositionedWord header,
        int searchLeft,
        int searchRight)
    {
        searchLeft = Math.Clamp(searchLeft, 0, bitmap.Width - 1);
        searchRight = Math.Clamp(searchRight, searchLeft + 1, bitmap.Width);
        var fromY = Math.Max(0, header.Top - header.Height * 2);
        var toY = Math.Min(bitmap.Height, header.Bottom + (int)(bitmap.Height * 0.58));
        var counts = new int[searchRight - searchLeft];

        for (var x = searchLeft; x < searchRight; x++)
        {
            var dark = 0;
            for (var y = fromY; y < toY; y++)
            {
                var c = bitmap.GetPixel(x, y);
                if (((c.Red * 299) + (c.Green * 587) + (c.Blue * 114)) < 120000)
                    dark++;
            }
            counts[x - searchLeft] = dark;
        }

        var maximum = counts.Length == 0 ? 0 : counts.Max();
        if (maximum < 20) return (0, 0);
        var threshold = Math.Max(15, (int)Math.Round(maximum * 0.55));
        var hits = Enumerable.Range(0, counts.Length)
            .Where(i => counts[i] >= threshold)
            .Select(i => i + searchLeft)
            .ToList();
        if (hits.Count < 2) return (0, 0);

        return (hits.First(), hits.Last() + 1);
    }

    private static (int Left, int Right) FindScheduleHorizontalBounds(
        SKBitmap bitmap,
        OcrPositionedWord header)
    {
        var fallbackLeft = Math.Max(0, header.Left - header.Height * 4);
        var fallbackRight = Math.Min(bitmap.Width, header.Right + header.Height * 4);
        var bestLeft = fallbackLeft;
        var bestRight = fallbackRight;
        var bestLength = bestRight - bestLeft;
        var fromY = Math.Max(0, header.Top - header.Height * 3);
        var toY = Math.Min(bitmap.Height - 1, header.Bottom + header.Height * 4);

        for (var y = fromY; y <= toY; y++)
        {
            var runStart = -1;
            var lastDark = -1;
            var gap = 0;
            for (var x = 0; x < bitmap.Width; x++)
            {
                var c = bitmap.GetPixel(x, y);
                var dark = ((c.Red * 299) + (c.Green * 587) + (c.Blue * 114)) < 150000;
                if (dark)
                {
                    if (runStart < 0) runStart = x;
                    lastDark = x;
                    gap = 0;
                }
                else if (runStart >= 0 && ++gap > 2)
                {
                    var length = lastDark - runStart + 1;
                    if (runStart <= header.CenterX && lastDark >= header.CenterX
                        && length > bestLength)
                    {
                        bestLeft = runStart;
                        bestRight = lastDark + 1;
                        bestLength = length;
                    }
                    runStart = -1;
                    lastDark = -1;
                    gap = 0;
                }
            }
        }
        return (bestLeft, bestRight);
    }

    private static int FindScheduleBottom(
        SKBitmap bitmap,
        int left,
        int right,
        int startY)
    {
        var horizontalRules = new List<int>();
        var ruleThreshold = Math.Max(80, (int)((right - left) * 0.55));
        var scanLimit = Math.Min(bitmap.Height - 1,
            startY + (int)(bitmap.Height * 0.70));
        for (var y = startY; y <= scanLimit; y++)
        {
            var dark = 0;
            for (var x = left; x < right; x++)
            {
                var c = bitmap.GetPixel(x, y);
                if (((c.Red * 299) + (c.Green * 587) + (c.Blue * 114)) < 150000)
                    dark++;
            }
            if (dark >= ruleThreshold) horizontalRules.Add(y);
        }
        if (horizontalRules.Count > 0)
            return horizontalRules.Last();

        var lastBothEdges = startY;
        for (var y = startY; y <= scanLimit; y++)
        {
            static bool HasDarkNear(SKBitmap image, int x, int y)
            {
                for (var xx = Math.Max(0, x - 3); xx <= Math.Min(image.Width - 1, x + 3); xx++)
                {
                    var c = image.GetPixel(xx, y);
                    if (((c.Red * 299) + (c.Green * 587) + (c.Blue * 114)) < 150000)
                        return true;
                }
                return false;
            }

            if (HasDarkNear(bitmap, left, y) && HasDarkNear(bitmap, right - 1, y))
                lastBothEdges = y;
        }
        return lastBothEdges;
    }

    private static List<string> ReconstructOcrScheduleRows(
        List<OcrPositionedWord> words,
        int tableHeight)
    {
        if (words.Count == 0) return [];
        var medianHeight = words.Select(w => w.Height).OrderBy(h => h)
            .ElementAt(words.Count / 2);
        var tolerance = Math.Max(5, (int)Math.Round(medianHeight * 0.70));
        var ordered = words.OrderBy(w => w.CenterY).ThenBy(w => w.Left).ToList();
        var groups = new List<List<OcrPositionedWord>>();

        foreach (var word in ordered)
        {
            var group = groups.LastOrDefault(g =>
                Math.Abs(g.Average(x => x.CenterY) - word.CenterY) <= tolerance);
            if (group == null)
            {
                group = [];
                groups.Add(group);
            }
            group.Add(word);
        }

        return groups
            .Where(g => g.Average(w => w.CenterY) < tableHeight * 0.98)
            .Select(g => string.Join(" ", g.OrderBy(w => w.Left).Select(w => w.Text)))
            .Where(l => l.Length > 1)
            .ToList();
    }

    private static List<SKRectI> BuildTargetedScheduleCrops(int width, int height)
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
            Rect(0.720, 0.035, 0.850, 0.565, width, height),
            Rect(0.845, 0.035, 0.978, 0.575, width, height),
            Rect(0.760, 0.145, 0.985, 0.575, width, height),
        ];
    }

    private static List<string> OcrScheduleTableRegion(
        TesseractEngine engine,
        SKBitmap source,
        SKRectI crop)
    {
        using var cropped = new SKBitmap(crop.Width, crop.Height);
        using (var canvas = new SKCanvas(cropped))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, crop, new SKRect(0, 0, crop.Width, crop.Height));
        }

        // Pages are rendered at 320 DPI, so the table text is already comfortably above
        // Tesseract's preferred input size. OCR the native crop to keep this bounded.
        using var pngData = cropped.Encode(SKEncodedImageFormat.Png, 100);
        using var pix = Pix.LoadFromMemory(pngData.ToArray());
        using var tessPage = engine.Process(pix, PageSegMode.SingleBlock);

        return (tessPage.GetText() ?? string.Empty)
            .Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => NormalizeScheduleOcrLine(Regex.Replace(l.Trim(), @"\s+", " ")))
            .Where(l => l.Length > 1 && !IsMetadataLine(l))
            .ToList();
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
            // Deep right-side schedules on A1/A0 roof plans.
            Rect(0.745, 0.100, 0.995, 0.600, width, height),
            Rect(0.700, 0.050, 0.995, 0.650, width, height),
            // Two adjacent MEMBER SCHEDULE blocks: OCR each column independently so
            // rows at the same height are not interleaved.
            Rect(0.700, 0.025, 0.855, 0.620, width, height),
            Rect(0.835, 0.025, 0.985, 0.650, width, height),
        ];
    }

    private static List<string> ExtractGridScheduleRows(TesseractEngine engine, SKBitmap bitmap)
    {
        static SKRectI Rect(double left, double top, double right, double bottom, int w, int h)
        {
            var l = Math.Clamp((int)Math.Round(w * left), 0, w - 1);
            var t = Math.Clamp((int)Math.Round(h * top), 0, h - 1);
            var r = Math.Clamp((int)Math.Round(w * right), l + 1, w);
            var b = Math.Clamp((int)Math.Round(h * bottom), t + 1, h);
            return new SKRectI(l, t, r, b);
        }

        var regions = new[]
        {
            // The supported drawings place schedule grids in one of these narrow right-side
            // bands. Keeping the bands tight avoids treating plan/detail lines as table rows.
            Rect(0.720, 0.035, 0.850, 0.555, bitmap.Width, bitmap.Height),
            Rect(0.850, 0.035, 0.975, 0.565, bitmap.Width, bitmap.Height),
            Rect(0.760, 0.145, 0.985, 0.575, bitmap.Width, bitmap.Height),
        };

        var allLines = new List<string>();
        foreach (var region in regions)
        {
            var lineCenters = DetectHorizontalRuleCenters(bitmap, region);
            if (lineCenters.Count < 5) continue;

            for (var i = 0; i < lineCenters.Count - 1; i++)
            {
                var top = lineCenters[i] + 3;
                var bottom = lineCenters[i + 1] - 3;
                var height = bottom - top;
                if (height < 12 || height > 220) continue;

                var rowCrop = new SKRectI(
                    region.Left + 3,
                    Math.Clamp(top, region.Top, region.Bottom - 1),
                    region.Right - 3,
                    Math.Clamp(bottom, region.Top + 1, region.Bottom));
                if (rowCrop.Width < 40 || rowCrop.Height < 8) continue;

                var best = OcrScheduleGridRow(engine, bitmap, rowCrop)
                    .Select(l => NormalizeScheduleOcrLine(Regex.Replace(l.Trim(), @"\s+", " ")))
                    .Where(l => l.Length > 1 && !IsMetadataLine(l))
                    .OrderByDescending(ScoreScheduleRowCandidate)
                    .ThenByDescending(l => l.Length)
                    .FirstOrDefault();

                if (!string.IsNullOrWhiteSpace(best))
                    allLines.Add(best);
            }
        }

        return allLines
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<int> DetectHorizontalRuleCenters(SKBitmap bitmap, SKRectI region)
    {
        var hits = new List<int>();
        // A real schedule rule spans most of the narrow table band. The previous 35% cutoff
        // also selected dense text rows and produced hundreds of expensive false OCR crops.
        var threshold = Math.Max(80, (int)(region.Width * 0.55));

        for (var y = region.Top; y < region.Bottom; y++)
        {
            var dark = 0;
            for (var x = region.Left; x < region.Right; x++)
            {
                var c = bitmap.GetPixel(x, y);
                var lum = (c.Red * 0.299) + (c.Green * 0.587) + (c.Blue * 0.114);
                if (lum < 100) dark++;
            }
            if (dark >= threshold) hits.Add(y);
        }

        if (hits.Count == 0) return [];

        var centers = new List<int>();
        var start = hits[0];
        var end = hits[0];
        foreach (var y in hits.Skip(1))
        {
            if (y <= end + 2)
            {
                end = y;
                continue;
            }
            centers.Add((start + end) / 2);
            start = end = y;
        }
        centers.Add((start + end) / 2);
        return centers;
    }

    private static List<string> OcrScheduleGridRow(
        TesseractEngine engine,
        SKBitmap source,
        SKRectI crop)
    {
        using var cropped = new SKBitmap(crop.Width, crop.Height);
        using (var canvas = new SKCanvas(cropped))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, crop, new SKRect(0, 0, crop.Width, crop.Height));
        }

        // The source page is already rendered at 320 DPI; a fixed 2x pass is enough for the
        // small schedule font and prevents the 3-8x per-row expansion used by mark detection.
        using var scaled = new SKBitmap(cropped.Width * 2, cropped.Height * 2);
        using (var canvas = new SKCanvas(scaled))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(cropped, new SKRect(0, 0, scaled.Width, scaled.Height));
        }

        using var pngData = scaled.Encode(SKEncodedImageFormat.Png, 100);
        using var pix = Pix.LoadFromMemory(pngData.ToArray());
        using var tessPage = engine.Process(pix, PageSegMode.SingleLine);

        return (tessPage.GetText() ?? string.Empty)
            .Split(new[] { '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToList();
    }

    private static int ScoreScheduleRowCandidate(string line)
    {
        var score = 0;
        if (Regex.IsMatch(line, @"^\s*[A-Z]{1,5}\d{1,3}[A-Z]?\b", RegexOptions.IgnoreCase))
            score += 20;
        if (SteelSectionPattern.IsMatch(line)
            || HollowSectionPattern.IsMatch(line)
            || PurlinSectionPattern.IsMatch(line)
            || RodBracingPattern.IsMatch(line))
            score += 12;
        if (Regex.IsMatch(line, @"\b(MARK|SIZE|MEMBER|RAFTERS|BEAMS|PURLINS|BRACING)\b",
                RegexOptions.IgnoreCase))
            score += 8;
        return score;
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
        line = Regex.Replace(line, @"(^|\s)[€©]\s*(?=\d)", "$1C");
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
            if (Regex.IsMatch(upper, @"^\s*[A-Z]{1,4}\d{1,3}[A-Z]?\s+.{2,}$")) score += 3;
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

    private List<ExtractedMemberDto> ParseMembers(
        List<string> lines,
        string fullText,
        List<ExtractedMemberDto>? variantScheduleMembers = null,
        List<ExtractedMemberDto>? columnScheduleMembers = null)
    {
        // Merge split mark tokens produced by CAD PDFs: "PF 2" → "PF2", "C 1" → "C1"
        var mergedLines = lines.Select(MergeMarkFragments).ToList();
        var mergedFullText = string.Join(" ", mergedLines);

        _logger.LogDebug("Extraction: {LineCount} lines after mark-fragment merge", mergedLines.Count);

        var results = new List<ExtractedMemberDto>();

        // A page with many coordinate-resolved MARK/a/b/c cells is an explicit multi-variant
        // reference schedule. Use those exact cells rather than flattening the row into text,
        // which loses column ownership and can mistake a preceding section size for a mark.
        // All ordinary drawings continue through the existing extraction logic unchanged.
        if (variantScheduleMembers is { Count: >= 10 })
        {
            results.AddRange(variantScheduleMembers);
            _logger.LogInformation(
                "Extraction: using {Count} coordinate-resolved multi-variant schedule cells",
                variantScheduleMembers.Count);
        }
        else if (columnScheduleMembers is { Count: >= 5 })
        {
            results.AddRange(columnScheduleMembers);
            _logger.LogInformation(
                "Extraction: using {Count} coordinate-resolved schedule rows",
                columnScheduleMembers.Count);
        }
        else
        {
            // COLUMNS / BEAMS lists on footing plans (SC2 - 360 UB 45, C1 - 610 UB 113)
            results.AddRange(ParseDrawingLists(mergedLines));
            _logger.LogDebug("After ParseDrawingLists: {Count} rows", results.Count);

            var scheduleStart = FindScheduleSection(mergedLines);
            if (scheduleStart >= 0)
                results.AddRange(ParseScheduleTable(mergedLines, scheduleStart));
            _logger.LogDebug("After ParseScheduleTable: {Count} rows", results.Count);

            results.AddRange(ParseByPattern(mergedLines, mergedFullText));
            _logger.LogDebug("After ParseByPattern: {Count} rows (pre-merge)", results.Count);
        }

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

    private sealed record VariantScheduleTable(
        Word Header,
        List<(string Suffix, double Center)> Columns,
        List<double> Boundaries,
        double Left,
        double Right);

    /// <summary>
    /// Reads CAD table geometry for schedules whose columns are explicitly headed
    /// MARK, a, b, c... . This is additive and deliberately narrow: pages without
    /// that header shape continue through the original line-based parsers.
    /// </summary>
    private List<ExtractedMemberDto> ExtractVariantScheduleCells(List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        const double rowTolerance = 3.0;
        const double markColumnTolerance = 25.0;

        var markHeaders = pageWords
            .Where(w => w.Text.Equals("MARK", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(w => w.BoundingBox.Bottom)
            .ThenBy(w => w.BoundingBox.Left)
            .ToList();

        var tables = new List<VariantScheduleTable>();
        foreach (var header in markHeaders)
        {
            var nextHeaderX = markHeaders
                .Where(h => Math.Abs(h.BoundingBox.Bottom - header.BoundingBox.Bottom) < rowTolerance
                    && h.BoundingBox.Left > header.BoundingBox.Left)
                .Select(h => h.BoundingBox.Left)
                .DefaultIfEmpty(double.MaxValue)
                .Min();

            var suffixCandidates = pageWords
                .Where(w => Math.Abs(w.BoundingBox.Bottom - header.BoundingBox.Bottom) < rowTolerance
                    && w.BoundingBox.Left > header.BoundingBox.Left
                    && w.BoundingBox.Left < nextHeaderX
                    && Regex.IsMatch(w.Text, @"^[A-L]$", RegexOptions.IgnoreCase))
                .OrderBy(w => w.BoundingBox.Left)
                .ToList();

            // Keep only the first consecutive A, B, C... sequence. Other nearby tables can
            // contribute another isolated "A" on the same baseline; treating that duplicate
            // as an extra column makes this table overlap and prematurely truncate its neighbour.
            var suffixWords = new List<Word>();
            var previousCenter = (header.BoundingBox.Left + header.BoundingBox.Right) / 2.0;
            double typicalSpacing = 0;
            for (var expected = 'A'; expected <= 'L'; expected++)
            {
                var candidate = suffixCandidates
                    .Where(w => w.Text.Equals(expected.ToString(), StringComparison.OrdinalIgnoreCase))
                    .Select(w => new
                    {
                        Word = w,
                        Center = (w.BoundingBox.Left + w.BoundingBox.Right) / 2.0
                    })
                    .Where(x => x.Center > previousCenter
                        && (typicalSpacing <= 0 || x.Center - previousCenter <= typicalSpacing * 1.8))
                    .OrderBy(x => x.Center)
                    .FirstOrDefault();

                if (candidate == null) break;
                suffixWords.Add(candidate.Word);
                if (typicalSpacing <= 0)
                    typicalSpacing = candidate.Center - previousCenter;
                previousCenter = candidate.Center;
            }

            if (suffixWords.Count == 0) continue;

            var headerCenter = (header.BoundingBox.Left + header.BoundingBox.Right) / 2.0;
            var columns = suffixWords
                .Select(w => (
                    w.Text.ToUpperInvariant(),
                    (w.BoundingBox.Left + w.BoundingBox.Right) / 2.0))
                .ToList();

            var centers = new List<double> { headerCenter };
            centers.AddRange(columns.Select(c => c.Item2));

            var boundaries = new List<double>();
            for (var i = 0; i < centers.Count - 1; i++)
                boundaries.Add((centers[i] + centers[i + 1]) / 2.0);

            var spacing = centers.Count > 1 ? centers[^1] - centers[^2] : 60.0;
            tables.Add(new VariantScheduleTable(
                header,
                columns,
                boundaries,
                header.BoundingBox.Left - markColumnTolerance,
                centers[^1] + spacing / 2.0));
        }

        // Require a genuine multi-variant header somewhere on the page. This prevents an
        // unrelated two-column table headed "MARK / A" from selecting this specialized mode.
        if (!tables.Any(t => t.Columns.Count >= 2)) return [];

        var results = new List<ExtractedMemberDto>();
        foreach (var table in tables)
        {
            var countBeforeTable = results.Count;
            var headerY = table.Header.BoundingBox.Bottom;

            // The table ends at the nearest lower MARK header whose horizontal range overlaps.
            // This handles stacked tables even when their mark columns are slightly offset.
            var lowerBoundary = tables
                .Where(t => t.Header.BoundingBox.Bottom < headerY - rowTolerance
                    && Math.Min(table.Right, t.Right) - Math.Max(table.Left, t.Left) > 20)
                .Select(t => t.Header.BoundingBox.Bottom)
                .DefaultIfEmpty(double.MinValue)
                .Max();

            var rowGroups = pageWords
                .Where(w => w.BoundingBox.Bottom < headerY - rowTolerance
                    && w.BoundingBox.Bottom > lowerBoundary + rowTolerance
                    && w.BoundingBox.Left > table.Left
                    && w.BoundingBox.Left < table.Right)
                .GroupBy(w => (int)Math.Round(w.BoundingBox.Bottom / rowTolerance))
                .Select(g => g.OrderBy(w => w.BoundingBox.Left).ToList());

            foreach (var row in rowGroups)
            {
                var baseMarkWord = row
                    .Where(w => Math.Abs(w.BoundingBox.Left - table.Header.BoundingBox.Left)
                            < markColumnTolerance
                        && Regex.IsMatch(
                            w.Text,
                            @"^\d{0,2}[A-Z]{1,4}\d{1,3}[A-Z]?$",
                            RegexOptions.IgnoreCase))
                    .OrderBy(w => Math.Abs(w.BoundingBox.Left - table.Header.BoundingBox.Left))
                    .FirstOrDefault();

                if (baseMarkWord == null) continue;
                var baseMark = baseMarkWord.Text.ToUpperInvariant();

                for (var columnIndex = 0; columnIndex < table.Columns.Count; columnIndex++)
                {
                    var left = table.Boundaries[columnIndex];
                    var right = columnIndex + 1 < table.Boundaries.Count
                        ? table.Boundaries[columnIndex + 1]
                        : table.Right;

                    var cellText = string.Join(" ", row
                        .Where(w =>
                        {
                            var center = (w.BoundingBox.Left + w.BoundingBox.Right) / 2.0;
                            return center >= left && center < right;
                        })
                        .OrderBy(w => w.BoundingBox.Left)
                        .Select(w => w.Text))
                        .Trim();

                    if (cellText.Length < 2) continue;

                    var fullMark = baseMark + table.Columns[columnIndex].Suffix;
                    var section = NormalizeSection(cellText);
                    results.Add(new ExtractedMemberDto(
                        fullMark,
                        section,
                        DetectMemberType(fullMark, section),
                        0, 0, 0,
                        $"Schedule cell: {fullMark} = {cellText}",
                        0.99));
                }
            }

            _logger.LogInformation(
                "Variant schedule table x={X:F1}, y={Y:F1}, columns={Columns}, rows={Rows}",
                table.Header.BoundingBox.Left,
                table.Header.BoundingBox.Bottom,
                table.Columns.Count,
                results.Count - countBeforeTable);
        }

        return results;
    }

    private sealed record ColumnScheduleTable(
        Word MarkHeader,
        Word ValueHeader,
        double Left,
        double Middle,
        double Right);

    /// <summary>
    /// Reads ordinary two-column schedules when their native PDF text exposes aligned
    /// MARK/SIZE or ITEM/MEMBER headers. Geometry keeps adjacent schedule columns separate.
    /// </summary>
    private static List<ExtractedMemberDto> ExtractColumnScheduleRows(List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        const double rowTolerance = 4.0;
        const double markColumnTolerance = 25.0;
        var tables = new List<ColumnScheduleTable>();

        foreach (var (markHeaderText, valueHeaderText) in new[]
        {
            ("MARK", "SIZE"),
            ("ITEM", "MEMBER")
        })
        {
            var markHeaders = pageWords
                .Where(w => w.Text.Equals(markHeaderText, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(w => w.BoundingBox.Bottom)
                .ThenBy(w => w.BoundingBox.Left)
                .ToList();

            foreach (var markHeader in markHeaders)
            {
                var valueHeader = pageWords
                    .Where(w => w.Text.Equals(valueHeaderText, StringComparison.OrdinalIgnoreCase)
                        && Math.Abs(w.BoundingBox.Bottom - markHeader.BoundingBox.Bottom) < rowTolerance
                        && w.BoundingBox.Left > markHeader.BoundingBox.Left)
                    .OrderBy(w => w.BoundingBox.Left)
                    .FirstOrDefault();

                if (valueHeader == null) continue;

                var nextMarkX = markHeaders
                    .Where(h => Math.Abs(h.BoundingBox.Bottom - markHeader.BoundingBox.Bottom) < rowTolerance
                        && h.BoundingBox.Left > markHeader.BoundingBox.Left)
                    .Select(h => h.BoundingBox.Left)
                    .DefaultIfEmpty(double.MaxValue)
                    .Min();

                var columnDistance = valueHeader.BoundingBox.Left - markHeader.BoundingBox.Left;
                var right = nextMarkX < double.MaxValue
                    ? nextMarkX - 8
                    : valueHeader.BoundingBox.Left + columnDistance * 1.1;

                tables.Add(new ColumnScheduleTable(
                    markHeader,
                    valueHeader,
                    markHeader.BoundingBox.Left - markColumnTolerance,
                    (markHeader.BoundingBox.Left + valueHeader.BoundingBox.Left) / 2.0,
                    right));
            }
        }

        var results = new List<ExtractedMemberDto>();
        foreach (var table in tables)
        {
            // Stacked schedules often share the same MARK column (for example floor,
            // column, then truss schedules). Stop this table at the next lower MARK
            // header whose horizontal range overlaps, otherwise the upper table can
            // skip its digit-prefixed rows and incorrectly consume rows from below.
            var lowerBoundary = tables
                .Where(t => t.MarkHeader.BoundingBox.Bottom
                                < table.MarkHeader.BoundingBox.Bottom - rowTolerance
                    && Math.Min(table.Right, t.Right) - Math.Max(table.Left, t.Left) > 20)
                .Select(t => t.MarkHeader.BoundingBox.Bottom)
                .DefaultIfEmpty(double.MinValue)
                .Max();

            var candidateRows = pageWords
                .Where(w => w.BoundingBox.Bottom < table.MarkHeader.BoundingBox.Bottom - rowTolerance
                    && w.BoundingBox.Bottom > lowerBoundary + rowTolerance
                    && w.BoundingBox.Left > table.Left
                    && w.BoundingBox.Left < table.Right)
                .GroupBy(w => (int)Math.Round(w.BoundingBox.Bottom / rowTolerance))
                .Select(g => g.OrderBy(w => w.BoundingBox.Left).ToList())
                .Select(row =>
                {
                    var markWord = row
                        .Where(w => Math.Abs(w.BoundingBox.Left - table.MarkHeader.BoundingBox.Left)
                                < markColumnTolerance
                            && Regex.IsMatch(
                                w.Text,
                                "^" + MarkPrefix + @"[A-Z]{1,5}[A-Z0-9]{0,4}"
                                    + CompoundMarkSuffix + @"\*?$",
                                RegexOptions.IgnoreCase))
                        .OrderBy(w => Math.Abs(w.BoundingBox.Left - table.MarkHeader.BoundingBox.Left))
                        .FirstOrDefault();

                    if (markWord == null) return null;

                    var value = string.Join(" ", row
                        .Where(w =>
                        {
                            var center = (w.BoundingBox.Left + w.BoundingBox.Right) / 2.0;
                            return center >= table.Middle && center < table.Right;
                        })
                        .OrderBy(w => w.BoundingBox.Left)
                        .Select(w => w.Text))
                        .Trim();

                    if (value.Length < 2) return null;
                    return new
                    {
                        Y = markWord.BoundingBox.Bottom,
                        Mark = markWord.Text.ToUpperInvariant(),
                        Value = value
                    };
                })
                .Where(x => x != null)
                .OrderByDescending(x => x!.Y)
                .ToList();

            double? previousY = null;
            foreach (var row in candidateRows)
            {
                if (row == null) continue;
                if (previousY.HasValue && previousY.Value - row.Y > 60) break;
                previousY = row.Y;

                if (row.Mark is "MARK" or "ITEM" or "SIZE" or "MEMBER"
                    or "STEEL" or "STRUCTURAL" or "COMMENTS") continue;
                var section = NormalizeSection(row.Value);
                results.Add(new ExtractedMemberDto(
                    row.Mark,
                    section,
                    DetectMemberType(row.Mark, section),
                    0, 0, 0,
                    $"Schedule row: {row.Mark} = {row.Value}",
                    0.99));
            }
        }

        return results;
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
        if (!Regex.IsMatch(r.Mark, "^" + MarkPrefix + @"[A-Z]{1,4}\d{0,3}[A-Z]?" + CompoundMarkSuffix + @"\*?$", RegexOptions.IgnoreCase))
            return false;
        // Auto-guess marks M1/M2 — not used on structural drawings
        if (Regex.IsMatch(r.Mark, @"^M\d+$", RegexOptions.IgnoreCase))
            return false;
        if (r.Confidence < 0.90 && !Regex.IsMatch(r.Mark, @"\d"))
            return false;

        var desc = r.Description.ToUpperInvariant();
        var hasDigit = Regex.IsMatch(r.Mark, @"\d");
        if (!hasDigit)
        {
            var coordinateResolved = desc.StartsWith(
                "SCHEDULE ROW:", StringComparison.OrdinalIgnoreCase);
            var hasRecognizedSection = SteelSectionPattern.IsMatch(r.MemberSize)
                || HollowSectionPattern.IsMatch(r.MemberSize)
                || PurlinSectionPattern.IsMatch(r.MemberSize)
                || RodBracingPattern.IsMatch(r.MemberSize);
            var hasTextMemberEvidence = Regex.IsMatch(r.MemberSize,
                @"\b(EXISTING|FASCIA|REFER\s+SECTION)\b",
                RegexOptions.IgnoreCase);

            // Single-letter selectable-text marks (A, B, C...) are valid in ordinary
            // coordinate-resolved schedules. Targeted OCR must provide stronger evidence.
            if (r.Mark.Length == 1
                && !coordinateResolved)
                return false;
            if (!coordinateResolved && r.Mark.Length > 3 && !hasTextMemberEvidence)
                return false;
            if (!coordinateResolved && !hasRecognizedSection && !hasTextMemberEvidence)
                return false;
        }

        if (Regex.IsMatch(desc,
                @"\b(PROVIDE|REINFORCEMENT|WELD\s+AT|WELD\s+ON|SLOTTED\s+HOLES|TRUSS\s+ELEVATION)\b"))
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
            @"^(ESC|EDP|EWH|EBR|EOR|EFT|FAB|RBR|EC|CC|DP|DB|HB|WB|DF|PF|SF|RW|CJ|SB|FB|RB|RA|WS|PB|ST|SC|OR|VB|BR|EB|ER|P|R|S|C|B|W)\d",
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
