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
    private sealed record CachedOcrWord(string Text, double XRatio, double YRatio);

    private readonly ILogger<ExtractionService> _logger;
    private readonly string _tessDataPath;
    private const int MarkDetectionDpi = 320;
    private static readonly ConcurrentDictionary<string, byte[]> RenderedPagePngCache = new();
    private static readonly ConcurrentDictionary<string, List<CachedOcrWord>> DrawingMarkOcrCache = new();
    private static readonly object DrawingMarkDetectionLock = new();

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

    // Cold-formed Z purlins in schedule tables are commonly written as
    // "Z20024 AT 600 CTS" (or "Z20024 AT 1200CTS").  They do not use the
    // C20019 lipped-channel notation above, so keep a separate, narrow pattern
    // that recognises the complete member size without treating note text as a
    // schedule row.
    private static readonly Regex ZPurlinSectionPattern = new(
        @"\bZ\d{3,5}\s*(?:AT|@)\s*\d{2,4}\s*(?:CTS|C\s*/\s*C|CENT(?:RE|ER)?S)?\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Plain Z/EZ cold-formed sections as printed in PURLIN/GIRT schedule member columns,
    // for example "EZ20015" or "Z15012". Spacing/lap information belongs to the NOTE
    // column and must not become part of the section size.
    private static readonly Regex PlainZPurlinSectionPattern = new(
        @"\bE?Z\s*\d{3,5}\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Pile/column schedules commonly express their size as "450mm DIA" or "Ø450".
    // Keep this deliberately narrow so ordinary dimension notes are not treated as members.
    private static readonly Regex DiameterSectionPattern = new(
        @"(?:\b\d{2,4}\s*mm\s*(?:DIA|DIAMETER)\b|[Ø]\s*\d{2,4}\b|\b\d{2,4}\s*DIA\b)",
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
        "BRACINGS", "CRANE RUNWAY BEAMS", "TRUSSES/FRAME", "TRUSSES / FRAME",
        "PURLINS / GIRTS", "PURLINS / GIRTS / CEILING JOISTS",
        "FLOOR BEAMS", "FLOORBEAMS", "ROOF BEAMS", "PAD FOOTINGS", "STRUTS",
        "STRIP FOOTINGS",
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
            var numberedScheduleMembers = new List<ExtractedMemberDto>();
            var headerlessScheduleMembers = new List<ExtractedMemberDto>();
            var coordinateDrawingListMembers = new List<ExtractedMemberDto>();
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
                    // Schedules headed No./MEMBER/SIZE/NOTE need a separate, additive
                    // coordinate path. This keeps notes and adjacent drawing text out of
                    // the section-size field without changing any established parser.
                    numberedScheduleMembers.AddRange(ExtractNumberedScheduleRows(words));
                    // Some consultant drawings use a named, boxed schedule with no MARK/SIZE
                    // column-heading row. Resolve those rows from their table geometry instead
                    // of falling back to full-page Y bands that splice unrelated drawing text.
                    headerlessScheduleMembers.AddRange(
                        ExtractHeaderlessNamedScheduleRows(words));
                    // Drawing-list schedules often use two or more adjacent columns without
                    // MARK/SIZE headers. Resolve those columns independently so rows sharing
                    // the same Y coordinate cannot be spliced together.
                    coordinateDrawingListMembers.AddRange(
                        ExtractCoordinateDrawingListRows(words));
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
                allLines, fullText, variantScheduleMembers, columnScheduleMembers,
                coordinateDrawingListMembers, headerlessScheduleMembers,
                numberedScheduleMembers);

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
                        allLines, fullText, variantScheduleMembers, columnScheduleMembers,
                        coordinateDrawingListMembers, headerlessScheduleMembers,
                        numberedScheduleMembers);
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
        if (!File.Exists(filePath) || points.Count < 2)
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        var known = knownMarks
            .Select(m => m.Trim().ToUpperInvariant())
            .Where(m => Regex.IsMatch(m, @"^[A-Z]{1,4}\d{0,3}[A-Z]?$"))
            // Letter-only text on structural drawings is commonly a grid axis,
            // elevation, or note reference (A/B/BE/BR...). It is too ambiguous
            // to assign automatically. An explicitly selected schedule row is
            // still authoritative and bypasses this detector entirely.
            .Where(m => Regex.IsMatch(m, @"\d"))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        using var pdf = PdfDocument.Open(filePath);
        var pageIndex = Math.Clamp(pageNumber, 1, pdf.NumberOfPages) - 1;
        var pdfPage = pdf.GetPage(pageIndex + 1);
        var pageWidth = pdfPage.Width;
        var pageHeight = pdfPage.Height;

        // Vector PDFs already contain the authoritative text and coordinates.
        // Prefer that text layer over OCR so a printed FAB1 is read exactly and
        // immediately. Scanned/image-only PDFs continue into the OCR fallbacks.
        var nativeMark = DetectMarkFromPdfText(
            pdfPage, points, pageWidth, pageHeight, known);
        if (!string.IsNullOrWhiteSpace(nativeMark.Mark))
            return nativeMark;

        if (!Directory.Exists(_tessDataPath) ||
            !File.Exists(Path.Combine(_tessDataPath, "eng.traineddata")))
        {
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);
        }

        // Tesseract engines are CPU-heavy. Parallel interactive requests used
        // to compete for the same machine and turned a 3-5 second focused read
        // into 70+ seconds. Serialize only the OCR fallback; native PDF text
        // detection above remains fully concurrent and immediate.
        lock (DrawingMarkDetectionLock)
        {
            using var engine = new TesseractEngine(_tessDataPath, "eng", EngineMode.Default);
            engine.SetVariable("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
            engine.SetVariable("preserve_interword_spaces", "1");

            using var bitmap = GetRenderedPageBitmap(filePath, pageIndex, MarkDetectionDpi);
            if (bitmap == null) return new DetectDrawingMarkResponse(string.Empty, string.Empty);

            // Read only the small area around the actual measurement. Whole-
            // page OCR is both slow and spatially unsafe for repeated marks.
            return DetectMarkFromFocusedCrops(
                engine, bitmap, points, pageWidth, pageHeight, known);
        }
    }

    private static DetectDrawingMarkResponse DetectMarkFromFocusedCrops(
        TesseractEngine engine,
        SKBitmap bitmap,
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight,
        List<string> known)
    {
        var crops = BuildMeasurementMarkCropCandidates(
            points, pageWidth, pageHeight, bitmap.Width, bitmap.Height);
        var rawLines = new List<string>();
        var bestMark = string.Empty;
        var bestScore = double.NegativeInfinity;
        var candidateHits = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        DetectDrawingMarkResponse? EvaluateLines(
            List<string> lines,
            bool isLabelBand,
            bool allowOcrNearMatch,
            bool requireStandalone,
            int priority)
        {
            rawLines.AddRange(lines);
            foreach (var line in lines)
            {
                foreach (var candidate in ExtractMarkCandidates(line, known))
                {
                    var resolvedKnown = ResolveKnownOcrMark(candidate, known, allowOcrNearMatch);
                    // With an authoritative schedule vocabulary, an unrelated
                    // OCR-shaped token must not become a new member. It can only
                    // win if it is an exact/credible OCR match to a schedule mark.
                    if (known.Count > 0 && string.IsNullOrWhiteSpace(resolvedKnown))
                        continue;

                    var effectiveCandidate = resolvedKnown ?? candidate;
                    var isExactKnownCandidate = known.Any(mark =>
                        NormalizeDetectedOcrMark(mark).Equals(
                            NormalizeDetectedOcrMark(candidate),
                            StringComparison.OrdinalIgnoreCase));
                    var standaloneLabel = NormalizeDetectedOcrMark(line);
                    var isStandaloneCandidate = standaloneLabel.Equals(
                        NormalizeDetectedOcrMark(candidate),
                        StringComparison.OrdinalIgnoreCase);
                    if (requireStandalone && !isStandaloneCandidate && !isExactKnownCandidate)
                        continue;
                    if (isLabelBand && (isStandaloneCandidate || isExactKnownCandidate))
                    {
                        return new DetectDrawingMarkResponse(
                            effectiveCandidate,
                            string.Join(" | ", rawLines.Distinct().Take(20)));
                    }

                    candidateHits[effectiveCandidate] =
                        candidateHits.GetValueOrDefault(effectiveCandidate) + 1;
                    var score = ScoreDetectedMark(effectiveCandidate, line, known)
                        + priority
                        + ((candidateHits[effectiveCandidate] - 1) * 35);
                    if (score > bestScore)
                    {
                        bestScore = score;
                        bestMark = effectiveCandidate;
                    }
                }
            }

            var hasReliableHit = candidateHits.GetValueOrDefault(bestMark) >= 2
                && bestScore >= 175;
            return !string.IsNullOrWhiteSpace(bestMark) && hasReliableHit
                ? new DetectDrawingMarkResponse(
                    bestMark, string.Join(" | ", rawLines.Distinct().Take(20)))
                : null;
        }

        // Labels printed along a diagonal/vertical member must be rotated into
        // reading orientation before OCR. Axis-aligned boxes frequently turn
        // rbr1 into RAB1 (or miss it completely).
        var alignedLines = OcrMeasurementAlignedLabelBand(
            engine, bitmap, points, pageWidth, pageHeight);
        var alignedResult = EvaluateLines(
            alignedLines,
            isLabelBand: true,
            allowOcrNearMatch: false,
            requireStandalone: true,
            priority: crops.Count + 4);
        if (alignedResult != null) return alignedResult;

        var isNearlyHorizontal = IsMeasurementNearlyHorizontal(
            points, pageWidth, pageHeight);

        // Tight label bands are sufficient after the aligned pass and keep the
        // interactive detector bounded. The old twelve-crop/two-mode loop ran
        // up to 24 OCR operations for a single line.
        var cropLimit = Math.Min(crops.Count, isNearlyHorizontal ? 4 : 2);
        for (var i = 0; i < cropLimit; i++)
        {
            // The first two crops are narrow bands immediately beside the
            // measured member. Keep the original vector letter shapes in those
            // bands: line-removal preprocessing can erase parts of small marks
            // such as FAB1. The remaining, wider crops still use the existing
            // high-contrast cleanup to suppress drawing/grid linework.
            var lines = i < 4
                ? OcrMeasurementLabelBand(engine, bitmap, crops[i])
                : OcrMeasurementMarkRegion(engine, bitmap, crops[i]);
            var cropResult = EvaluateLines(
                lines,
                isLabelBand: i < 4,
                // For a horizontal line, the isolated band is where PDF outline
                // OCR commonly confuses one glyph (FAB1 -> RAB1). Prefer the
                // same-length schedule mark at one edit; rotated labels require
                // an exact known mark so RBR1 cannot be coerced to FAB1.
                allowOcrNearMatch: isNearlyHorizontal && i < 4,
                requireStandalone: false,
                priority: Math.Max(0, crops.Count - i));
            if (cropResult != null) return cropResult;
        }

        return new DetectDrawingMarkResponse(
            string.Empty, string.Join(" | ", rawLines.Distinct().Take(20)));
    }

    private static DetectDrawingMarkResponse DetectMarkFromPdfText(
        UglyToad.PdfPig.Content.Page page,
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight,
        List<string> knownMarks)
    {
        var words = page.GetWords()
            .Where(word => !string.IsNullOrWhiteSpace(word.Text))
            .Select(word => new CachedOcrWord(
                word.Text,
                Math.Clamp(
                    ((word.BoundingBox.Left + word.BoundingBox.Right) / 2.0) / pageWidth,
                    0,
                    1),
                Math.Clamp(
                    1 - (((word.BoundingBox.Bottom + word.BoundingBox.Top) / 2.0) / pageHeight),
                    0,
                    1)))
            .ToList();

        return DetectMarkFromOcrWords(words, points, pageWidth, pageHeight, knownMarks);
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

            var detectedTableRows = ExtractDynamicScheduleTableLines(
                engine, bitmap, pdfPath, pageCount - 1);
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
        SKBitmap source,
        string pdfPath,
        int pageIndex)
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
        CacheDrawingMarkOcrWords(
            pdfPath, pageIndex, locatorWords, locator.Width, locator.Height);
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
                || ZPurlinSectionPattern.IsMatch(remainder)
                || PlainZPurlinSectionPattern.IsMatch(remainder)
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
                || ZPurlinSectionPattern.IsMatch(firstDescription)
                || PlainZPurlinSectionPattern.IsMatch(firstDescription)
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
                || ZPurlinSectionPattern.IsMatch(member)
                || PlainZPurlinSectionPattern.IsMatch(member)
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

    private static List<CachedOcrWord> GetOrCreateDrawingMarkOcrWords(
        TesseractEngine engine,
        string pdfPath,
        int pageIndex,
        SKBitmap source)
    {
        var key = BuildDrawingMarkOcrCacheKey(pdfPath, pageIndex);
        if (DrawingMarkOcrCache.TryGetValue(key, out var cached)) return cached;

        const int locatorWidth = 4600;
        var scale = Math.Min(1.0, locatorWidth / (double)source.Width);
        using var locator = new SKBitmap(
            Math.Max(1, (int)Math.Round(source.Width * scale)),
            Math.Max(1, (int)Math.Round(source.Height * scale)));
        using (var canvas = new SKCanvas(locator))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawBitmap(source, new SKRect(0, 0, locator.Width, locator.Height));
        }

        var words = OcrPositionedWords(engine, locator, PageSegMode.SparseText);
        return CacheDrawingMarkOcrWords(
            pdfPath, pageIndex, words, locator.Width, locator.Height);
    }

    private static List<CachedOcrWord> CacheDrawingMarkOcrWords(
        string pdfPath,
        int pageIndex,
        List<OcrPositionedWord> words,
        int width,
        int height)
    {
        var key = BuildDrawingMarkOcrCacheKey(pdfPath, pageIndex);
        var normalized = words
            .Where(word => !string.IsNullOrWhiteSpace(word.Text))
            .Select(word => new CachedOcrWord(
                word.Text,
                Math.Clamp(word.CenterX / (double)Math.Max(1, width), 0, 1),
                Math.Clamp(word.CenterY / (double)Math.Max(1, height), 0, 1)))
            .ToList();
        DrawingMarkOcrCache.TryAdd(key, normalized);
        return DrawingMarkOcrCache.TryGetValue(key, out var cached) ? cached : normalized;
    }

    private static string BuildDrawingMarkOcrCacheKey(string pdfPath, int pageIndex)
        => BuildRenderedPageCacheKey(pdfPath, pageIndex, MarkDetectionDpi) + "|drawing-marks-v1";

    private static DetectDrawingMarkResponse DetectMarkFromOcrWords(
        List<CachedOcrWord> words,
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight,
        List<string> knownMarks)
    {
        if (words.Count == 0 || points.Count < 2)
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        static double PageCoordinate(double value, double size)
            => value >= 0 && value <= 1 ? value * size : value;
        static double DistanceToSegment(
            double px, double py, double ax, double ay, double bx, double by)
        {
            var dx = bx - ax;
            var dy = by - ay;
            if (Math.Abs(dx) < .000001 && Math.Abs(dy) < .000001)
                return Math.Sqrt(Math.Pow(px - ax, 2) + Math.Pow(py - ay, 2));
            var t = Math.Clamp(((px - ax) * dx + (py - ay) * dy) / ((dx * dx) + (dy * dy)), 0, 1);
            var cx = ax + (t * dx);
            var cy = ay + (t * dy);
            return Math.Sqrt(Math.Pow(px - cx, 2) + Math.Pow(py - cy, 2));
        }

        var mapped = points
            .Select(point => new
            {
                X = PageCoordinate(point.X, pageWidth),
                Y = PageCoordinate(point.Y, pageHeight)
            })
            .Where(point => double.IsFinite(point.X) && double.IsFinite(point.Y))
            .ToList();
        if (mapped.Count < 2)
            return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        var first = mapped.First();
        var last = mapped.Last();
        var candidates = new Dictionary<string, (int Hits, double MinDistance, List<string> Raw)>(
            StringComparer.OrdinalIgnoreCase);
        var maxDistance = Math.Clamp(
            Math.Sqrt(Math.Pow(last.X - first.X, 2) + Math.Pow(last.Y - first.Y, 2)) * .24,
            45,
            180);

        foreach (var word in words)
        {
            var x = word.XRatio * pageWidth;
            var y = word.YRatio * pageHeight;
            var distance = DistanceToSegment(x, y, first.X, first.Y, last.X, last.Y);
            if (distance > maxDistance) continue;

            foreach (var candidate in ExtractMarkCandidates(word.Text, knownMarks)
                         .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (!candidates.TryGetValue(candidate, out var current))
                    current = (0, double.PositiveInfinity, []);
                current.Raw.Add(word.Text);
                candidates[candidate] = (
                    current.Hits + 1,
                    Math.Min(current.MinDistance, distance),
                    current.Raw);
            }
        }

        var best = candidates
            .Select(pair => new
            {
                Mark = pair.Key,
                pair.Value.Hits,
                pair.Value.MinDistance,
                pair.Value.Raw,
                Known = knownMarks.Any(mark => mark.Equals(pair.Key, StringComparison.OrdinalIgnoreCase)),
                Score = (knownMarks.Any(mark => mark.Equals(pair.Key, StringComparison.OrdinalIgnoreCase)) ? 160 : 0)
                    + (pair.Value.Hits * 30)
                    - (pair.Value.MinDistance * 2.5)
            })
            .OrderByDescending(candidate => candidate.Score)
            .ThenBy(candidate => candidate.MinDistance)
            .FirstOrDefault();

        if (best == null) return new DetectDrawingMarkResponse(string.Empty, string.Empty);
        var reliable = best.Known
            ? best.Score >= 145
            : best.Hits >= 2 || best.MinDistance <= Math.Min(35, maxDistance * .35);
        if (!reliable) return new DetectDrawingMarkResponse(string.Empty, string.Empty);

        var preferred = knownMarks.FirstOrDefault(mark =>
            mark.Equals(best.Mark, StringComparison.OrdinalIgnoreCase)) ?? best.Mark;
        return new DetectDrawingMarkResponse(
            preferred,
            string.Join(" | ", best.Raw.Distinct(StringComparer.OrdinalIgnoreCase).Take(20)));
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
            || ZPurlinSectionPattern.IsMatch(line)
            || PlainZPurlinSectionPattern.IsMatch(line)
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
        // A measurement crop is deliberately narrow. SingleLine handles the
        // common label-above-member case; SparseText recovers labels offset by
        // leader/dimension graphics. Avoid the old three-mode scan across a
        // large crop list, which made every manual line wait unnecessarily.
        foreach (var mode in new[] { PageSegMode.SingleLine, PageSegMode.SparseText })
        {
            lines.AddRange(OcrMeasurementMarkRegion(engine, source, crop, mode, highContrast: true));
        }

        return lines
            .Select(l => Regex.Replace(l.Trim(), @"\s+", " "))
            .Where(l => l.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<string> OcrMeasurementLabelBand(
        TesseractEngine engine,
        SKBitmap source,
        SKRectI crop)
    {
        // These are narrow, line-aligned label bands. One SingleLine pass is
        // enough; running SingleWord as well doubled every interactive wait.
        return OcrMeasurementMarkRegion(
                engine, source, crop, PageSegMode.SingleLine, highContrast: false)
            .Select(l => Regex.Replace(l.Trim(), @"\s+", " "))
            .Where(l => l.Length > 0)
            .ToList();
    }

    private static List<string> OcrMeasurementAlignedLabelBand(
        TesseractEngine engine,
        SKBitmap source,
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight)
    {
        static double N(double value, double size) =>
            value >= 0 && value <= 1 ? value * size : value;

        var mapped = points
            .Select(point => new SKPoint(
                (float)(N(point.X, pageWidth) / pageWidth * source.Width),
                (float)(N(point.Y, pageHeight) / pageHeight * source.Height)))
            .Where(point => float.IsFinite(point.X) && float.IsFinite(point.Y))
            .ToList();
        if (mapped.Count < 2) return [];

        var first = mapped.First();
        var last = mapped.Last();
        var dx = last.X - first.X;
        var dy = last.Y - first.Y;
        var length = Math.Sqrt((dx * dx) + (dy * dy));
        if (length < 20) return [];

        var angle = Math.Atan2(dy, dx) * 180.0 / Math.PI;
        while (angle > 90) angle -= 180;
        while (angle < -90) angle += 180;
        if (Math.Abs(angle) < 12) return [];

        var centerX = (first.X + last.X) / 2f;
        var centerY = (first.Y + last.Y) / 2f;
        var normalX = (float)(-dy / length);
        var normalY = (float)(dx / length);
        var labelOffset = (float)Math.Clamp(length * .08, 36, 60);
        var height = (int)Math.Round(Math.Clamp(length * .12, 66, 82));
        var lines = new List<string>();

        // Printed marks are normally just to one side of the member centreline.
        // Centre a narrow crop on each side after rotation; this keeps the mark
        // while moving the dashed/solid member line outside the OCR image.
        foreach (var side in new[] { -1f, 1f })
        {
            var width = (int)Math.Round(Math.Clamp(length, 300, 820));
            var alignedCenterX = centerX + (normalX * labelOffset * side);
            var alignedCenterY = centerY + (normalY * labelOffset * side);
            using var aligned = new SKBitmap(width, height);
            using (var canvas = new SKCanvas(aligned))
            {
                canvas.Clear(SKColors.White);
                canvas.Translate(width / 2f, height / 2f);
                canvas.RotateDegrees((float)-angle);
                canvas.Translate(-alignedCenterX, -alignedCenterY);
                canvas.DrawBitmap(source, 0, 0);
            }

            // The pale structural grid survives ordinary grayscale OCR and
            // competes with the small rotated label. Keep only genuinely
            // dark ink; the mark remains while gray gridlines disappear.
            for (var y = 0; y < aligned.Height; y++)
            {
                for (var x = 0; x < aligned.Width; x++)
                {
                    var color = aligned.GetPixel(x, y);
                    var luminance = (color.Red * .299) +
                                    (color.Green * .587) +
                                    (color.Blue * .114);
                    aligned.SetPixel(x, y, luminance < 125 ? SKColors.Black : SKColors.White);
                }
            }

            lines.AddRange(OcrMeasurementLabelBand(
                engine, aligned, new SKRectI(0, 0, aligned.Width, aligned.Height)));
        }

        return lines
            .Select(line => Regex.Replace(line.Trim(), @"\s+", " "))
            .Where(line => line.Length > 0)
            .ToList();
    }

    private static bool IsMeasurementNearlyHorizontal(
        List<MarkDetectionPointDto> points,
        double pageWidth,
        double pageHeight)
    {
        if (points.Count < 2) return true;
        static double N(double value, double size) =>
            value >= 0 && value <= 1 ? value * size : value;
        var first = points.First();
        var last = points.Last();
        var dx = N(last.X, pageWidth) - N(first.X, pageWidth);
        var dy = N(last.Y, pageHeight) - N(first.Y, pageHeight);
        return Math.Abs(Math.Atan2(dy, dx) * 180.0 / Math.PI) <= 12 ||
               Math.Abs(Math.Abs(Math.Atan2(dy, dx) * 180.0 / Math.PI) - 180) <= 12;
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
        // The source page is already rendered at 320 DPI. Capping the working
        // image near 1400 px retains glyph detail while avoiding multi-megapixel
        // OCR inputs for each tiny label crop.
        var upscale = Math.Clamp((int)Math.Floor(1400.0 / Math.Max(maxCropSide, 1)), 2, 4);
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
        // Member marks are commonly printed in a narrow band immediately above
        // or below their line. Isolating that band avoids grid/leader linework
        // that made Tesseract read FAB1 as unrelated marks such as A3.
        // Keep this band close to the measured line. On dense drawings a
        // farther, symmetric crop includes note text from the row above and
        // Tesseract ignores the small member mark directly over the line.
        var labelOffset = Math.Clamp(lineLen * 0.075, 45, 65);
        var labelX = Math.Clamp(lineLen * 0.55, 180, 420);
        // Include the full height of outlined PDF glyphs. The previous maximum
        // ended just above their baseline and turned FAB1 into an unreadable
        // half-word on this drawing.
        var labelY = Math.Clamp(lineLen * 0.07, 44, 56);
        var centeredLabelX = Math.Clamp(lineLen * 0.20, 130, 180);
        var centeredLabelY = Math.Clamp(lineLen * 0.065, 44, 50);

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
            // Try a tight center crop first. It contains the printed member mark
            // without the bay/grid lines that otherwise dominate SingleWord OCR.
            RectAround(midX - nx * labelOffset, midY - ny * labelOffset, centeredLabelX, centeredLabelY),
            RectAround(midX + nx * labelOffset, midY + ny * labelOffset, centeredLabelX, centeredLabelY),
            RectAround(midX - nx * labelOffset, midY - ny * labelOffset, labelX, labelY),
            RectAround(midX + nx * labelOffset, midY + ny * labelOffset, labelX, labelY),
            RectAround(midX, midY, stripX, stripY),
            RectAround(first.X, first.Y, endpointX, endpointY),
            RectAround(last.X, last.Y, endpointX, endpointY),
            RectAround(midX + nx * 24, midY + ny * 24, stripX, stripY),
            RectAround(midX - nx * 24, midY - ny * 24, stripX, stripY),
            RectAround(midX, midY, looseX, looseY),
            RectAround(midX + nx * 42, midY + ny * 42, looseX, looseY),
            RectAround(midX - nx * 42, midY - ny * 42, looseX, looseY),
        }
            .GroupBy(r => $"{r.Left}:{r.Top}:{r.Right}:{r.Bottom}")
            .Select(g => g.First())
            .ToList();
    }

    private static IEnumerable<string> ExtractMarkCandidates(string text, List<string> knownMarks)
    {
        var normalizedTokens = Regex.Matches(text.ToUpperInvariant(), @"[A-Z0-9]+")
            .Select(match => match.Value)
            .Where(token => !string.IsNullOrWhiteSpace(token))
            .ToList();
        foreach (var mark in knownMarks)
        {
            var upper = mark.Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(upper)) continue;
            var variants = BuildMarkOcrVariants(upper)
                .Where(variant => !string.IsNullOrWhiteSpace(variant))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            // Match a complete OCR token, never a substring of a paragraph or
            // another member mark. Substring matching made R4 win from prose
            // containing "...RA...", PM4 win from PM42, and A/BE win near FAB1.
            // OCR-shaped variants still handle isolated glyph ambiguity.
            var matches = normalizedTokens.Any(token => variants.Any(variant =>
                token.Equals(variant, StringComparison.OrdinalIgnoreCase)));
            if (matches) yield return upper;
        }

        // Also keep a tightly-shaped unknown mark candidate. Project schedules
        // are shared across PDFs and can legitimately omit the label printed
        // on the current drawing; known marks receive a strong score bonus,
        // but must not suppress an exact nearby label such as FAB1.
        foreach (Match match in Regex.Matches(text.ToUpperInvariant(), @"\b[A-Z]{1,4}\d{1,3}[A-Z]?\b"))
        {
            var token = NormalizeDetectedOcrMark(match.Value);
            if (IsPlausibleDetectedMark(token)) yield return token;
        }

    }

    private static string NormalizeDetectedOcrMark(string value)
        => Regex.Replace(value.ToUpperInvariant(), @"[^A-Z0-9]", "");

    private static string? ResolveKnownOcrMark(
        string candidate,
        List<string> knownMarks,
        bool allowNearMatch)
    {
        var normalized = NormalizeDetectedOcrMark(candidate);
        var exact = knownMarks.FirstOrDefault(mark =>
            NormalizeDetectedOcrMark(mark).Equals(normalized, StringComparison.OrdinalIgnoreCase));
        if (!string.IsNullOrWhiteSpace(exact)) return exact;
        if (!allowNearMatch || normalized.Length < 2) return null;

        // Outlined vector glyphs occasionally make a single character ambiguous
        // (FAB1 is commonly read as RAB1). Correct only one-edit candidates and
        // strongly prefer the same token length, so RA1 cannot beat FAB1 merely
        // because deleting one OCR glyph also has edit distance one.
        return knownMarks
            .Select(mark => new
            {
                Mark = mark,
                Normalized = NormalizeDetectedOcrMark(mark),
            })
            .Where(item => !string.IsNullOrWhiteSpace(item.Normalized))
            .Select(item => new
            {
                item.Mark,
                LengthDifference = Math.Abs(item.Normalized.Length - normalized.Length),
                Distance = LevenshteinDistance(normalized, item.Normalized),
            })
            .Where(item => item.Distance <= 1)
            .OrderBy(item => item.Distance)
            .ThenBy(item => item.LengthDifference)
            .ThenByDescending(item => item.Mark.Length)
            .Select(item => item.Mark)
            .FirstOrDefault();
    }

    private static int LevenshteinDistance(string left, string right)
    {
        if (left.Length == 0) return right.Length;
        if (right.Length == 0) return left.Length;

        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        var current = new int[right.Length + 1];
        for (var i = 1; i <= left.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= right.Length; j++)
            {
                var substitution = previous[j - 1] + (left[i - 1] == right[j - 1] ? 0 : 1);
                current[j] = Math.Min(
                    Math.Min(previous[j] + 1, current[j - 1] + 1),
                    substitution);
            }
            (previous, current) = (current, previous);
        }
        return previous[right.Length];
    }

    private static bool IsPlausibleDetectedMark(string token)
    {
        if (!Regex.IsMatch(token, @"^[A-Z]{1,4}\d{1,3}[A-Z]?$")) return false;
        if (Regex.IsMatch(token, @"^(MM|CM|KG|NO|PDF|UB|UC|PFC|TFC|RHS|SHS|CHS|EA|UA)\d*$",
                RegexOptions.IgnoreCase))
            return false;
        return true;
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
        yield return compact.Replace('4', 'T');
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
            // Small outlined B glyphs can close into D during raster OCR
            // (FAB1 -> FADI), especially directly beside a measurement line.
            'B' => ['B', '8', 'P', 'R', 'D'],
            '8' => ['8', 'B'],
            'D' => ['D', 'B'],
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
            // Small outlined 4 glyphs on structural drawings are frequently
            // read as T (R4 -> RT), especially after rotating a vertical mark.
            '4' => ['4', 'A', 'T'],
            'T' => ['T', '4'],
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
            || Regex.IsMatch(lower, @"\b(ph\.|www\.|\.com|@|drawing no|drawn|checked|approved)\b")
            || Regex.IsMatch(lower, @"\b(pty\s+ltd|limited|llc|incorporated|corporation|company)\b");
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

    private sealed record PositionedDrawingListLine(
        string Text,
        double Left,
        double Right,
        double Bottom);

    /// <summary>
    /// Resolves adjacent COLUMNS / BEAMS / PURLINS-style lists by coordinates.
    /// CAD PDFs can put two independent list rows on the same Y coordinate. The
    /// full-page text path joins them; this narrow path keeps the columns separate.
    /// </summary>
    private List<ExtractedMemberDto> ExtractCoordinateDrawingListRows(List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        const double rowTolerance = 4.0;
        const double horizontalColumnGap = 18.0;
        const double columnLeftTolerance = 12.0;
        const double maximumColumnWidth = 280.0;
        const double maximumBlockDepth = 180.0;

        var segments = new List<PositionedDrawingListLine>();
        var visualRows = pageWords
            .GroupBy(w => (int)Math.Round(w.BoundingBox.Bottom / rowTolerance))
            .Select(g => g.OrderBy(w => w.BoundingBox.Left).ToList());

        foreach (var row in visualRows)
        {
            var current = new List<Word>();

            void Flush()
            {
                if (current.Count == 0) return;
                var text = NormalizeCoordinateDrawingListText(
                    string.Join(" ", current.Select(w => w.Text)));
                if (text.Length > 0)
                {
                    segments.Add(new PositionedDrawingListLine(
                        text,
                        current.Min(w => w.BoundingBox.Left),
                        current.Max(w => w.BoundingBox.Right),
                        current.Average(w => w.BoundingBox.Bottom)));
                }
                current.Clear();
            }

            foreach (var word in row)
            {
                if (current.Count > 0
                    && word.BoundingBox.Left - current[^1].BoundingBox.Right
                        > horizontalColumnGap)
                {
                    Flush();
                }
                current.Add(word);
            }
            Flush();
        }

        var headers = segments
            .Where(s => IsExactCoordinateDrawingListHeader(s.Text))
            .OrderBy(s => s.Left)
            .ThenByDescending(s => s.Bottom)
            .ToList();
        if (headers.Count == 0) return [];

        // Headers with nearly the same left edge belong to one vertical list column.
        var headerColumns = new List<List<PositionedDrawingListLine>>();
        foreach (var header in headers)
        {
            var column = headerColumns.FirstOrDefault(c =>
                Math.Abs(c.Average(h => h.Left) - header.Left) <= 35.0);
            if (column == null)
            {
                column = [];
                headerColumns.Add(column);
            }
            column.Add(header);
        }
        headerColumns = headerColumns
            .OrderBy(c => c.Average(h => h.Left))
            .ToList();

        var results = new List<ExtractedMemberDto>();
        for (var columnIndex = 0; columnIndex < headerColumns.Count; columnIndex++)
        {
            var columnHeaders = headerColumns[columnIndex]
                .OrderByDescending(h => h.Bottom)
                .ToList();
            var columnLeft = columnHeaders.Average(h => h.Left);
            var columnRight = columnIndex + 1 < headerColumns.Count
                ? (columnLeft + headerColumns[columnIndex + 1].Average(h => h.Left)) / 2.0
                : columnLeft + maximumColumnWidth;

            for (var headerIndex = 0; headerIndex < columnHeaders.Count; headerIndex++)
            {
                var header = columnHeaders[headerIndex];
                var lowerBoundary = headerIndex + 1 < columnHeaders.Count
                    ? columnHeaders[headerIndex + 1].Bottom
                    : header.Bottom - maximumBlockDepth;

                var blockLines = segments
                    .Where(s => s.Bottom < header.Bottom - 0.5
                        && s.Bottom > lowerBoundary + 0.5
                        && s.Left >= columnLeft - columnLeftTolerance
                        && s.Left < columnRight)
                    .OrderByDescending(s => s.Bottom)
                    .ToList();

                for (var lineIndex = 0; lineIndex < blockLines.Count; lineIndex++)
                {
                    var line = blockLines[lineIndex];
                    if (IsExactCoordinateDrawingListHeader(line.Text)) continue;

                    var groupedMarks = ExtractGroupedDrawingListMarks(line.Text, out var rest);
                    if (groupedMarks.Count >= 2)
                    {
                        if (string.IsNullOrWhiteSpace(rest)
                            && lineIndex + 1 < blockLines.Count
                            && line.Bottom - blockLines[lineIndex + 1].Bottom <= 14
                            && !IsExactCoordinateDrawingListHeader(
                                blockLines[lineIndex + 1].Text))
                        {
                            rest = blockLines[lineIndex + 1].Text;
                        }

                        if (!string.IsNullOrWhiteSpace(rest))
                        {
                            foreach (var mark in groupedMarks)
                            {
                                var groupedMember = TryParseDrawingListLine(
                                    $"{mark} - {rest}");
                                if (groupedMember != null
                                    && !IsCoordinateDrawingListNoise(groupedMember))
                                {
                                    results.Add(groupedMember with
                                    {
                                        Description =
                                            $"Coordinate list: {TruncateLine(line.Text)}",
                                        Confidence = 0.99
                                    });
                                }
                            }
                        }
                        continue;
                    }

                    // Require an explicit dash here. Space-only rows stay on the existing
                    // fallback path, so plan labels and revision text cannot enter this set.
                    var member = TryParseDrawingListLine(line.Text);
                    if (member != null && !IsCoordinateDrawingListNoise(member))
                    {
                        results.Add(member with
                        {
                            Description =
                                $"Coordinate list: {TruncateLine(line.Text)}",
                            Confidence = 0.99
                        });
                    }
                }
            }
        }

        return results;
    }

    private static bool IsCoordinateDrawingListNoise(ExtractedMemberDto member)
    {
        var mark = member.Mark.ToUpperInvariant();
        var value = member.MemberSize.ToUpperInvariant();

        // Drawing schedules use S1, S2... for sheet numbers and reinforcing notes
        // use N12-300 CTS. Both have the same superficial "mark - value" shape as a
        // member row, so require their accompanying text to show member evidence.
        if (Regex.IsMatch(mark, @"^S\d{1,3}$"))
        {
            var hasMemberSection = SteelSectionPattern.IsMatch(value)
                || HollowSectionPattern.IsMatch(value)
                || PurlinSectionPattern.IsMatch(value)
                || ZPurlinSectionPattern.IsMatch(value)
                || PlainZPurlinSectionPattern.IsMatch(value)
                || RodBracingPattern.IsMatch(value);
            var hasMemberDescription = Regex.IsMatch(value,
                @"\b(STRUT|BRACE|MEMBER)\b");
            if (!hasMemberSection && !hasMemberDescription)
                return true;
        }
        if (Regex.IsMatch(mark, @"^N\d{1,3}$")
            && Regex.IsMatch(value,
                @"\b(CTS|CENTRES|EACH\s+WAY|TOP|BOTTOM|LONG)\b"))
            return true;

        return false;
    }

    private static bool IsExactCoordinateDrawingListHeader(string line)
    {
        var upper = line.Trim().Trim(':', '-', '–', '—').ToUpperInvariant();
        var compact = Regex.Replace(upper, @"[\s/]+", "");
        return DrawingListSections.Any(section =>
            compact.Equals(
                Regex.Replace(section.ToUpperInvariant(), @"[\s/]+", ""),
                StringComparison.Ordinal));
    }

    private static string NormalizeCoordinateDrawingListText(string text)
    {
        var tokens = Regex.Split(Regex.Replace(text.Trim(), @"\s+", " "), @"\s+")
            .Where(t => t.Length > 0)
            .ToList();
        var normalized = new List<string>();
        var glyphRun = new List<string>();

        void FlushGlyphRun()
        {
            if (glyphRun.Count == 0) return;
            normalized.Add(string.Concat(glyphRun));
            glyphRun.Clear();
        }

        foreach (var token in tokens)
        {
            if (Regex.IsMatch(token, @"^[A-Z0-9xX]$", RegexOptions.IgnoreCase))
            {
                glyphRun.Add(token);
                continue;
            }

            FlushGlyphRun();
            normalized.Add(token);
        }
        FlushGlyphRun();

        return MergeMarkFragments(string.Join(" ", normalized));
    }

    private static List<string> ExtractGroupedDrawingListMarks(
        string line,
        out string rest)
    {
        rest = string.Empty;
        var separator = Regex.Match(line, @"\s+[-–—]\s*");
        if (!separator.Success) return [];

        var prefix = line[..separator.Index].Trim();
        var markPattern = MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?";
        var marks = Regex.Matches(
                prefix,
                @"\b(" + markPattern + @")\b",
                RegexOptions.IgnoreCase)
            .Select(m => m.Groups[1].Value.ToUpperInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (marks.Count < 2) return [];

        var remaining = Regex.Replace(
            prefix,
            @"\b(?:" + markPattern + @")\b",
            "",
            RegexOptions.IgnoreCase);
        if (Regex.Replace(remaining, @"[\s,/&]+", "").Length > 0)
            return [];

        rest = line[(separator.Index + separator.Length)..].Trim();
        return marks;
    }

    private List<ExtractedMemberDto> ParseMembers(
        List<string> lines,
        string fullText,
        List<ExtractedMemberDto>? variantScheduleMembers = null,
        List<ExtractedMemberDto>? columnScheduleMembers = null,
        List<ExtractedMemberDto>? coordinateDrawingListMembers = null,
        List<ExtractedMemberDto>? headerlessScheduleMembers = null,
        List<ExtractedMemberDto>? numberedScheduleMembers = null)
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
        else if (headerlessScheduleMembers != null
            && headerlessScheduleMembers
                .Select(row => row.Mark)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Count() >= 10)
        {
            results.AddRange(headerlessScheduleMembers);
            _logger.LogInformation(
                "Extraction: using {Count} rows from named headerless schedule tables",
                headerlessScheduleMembers.Count);
        }
        else if (columnScheduleMembers is { Count: >= 5 })
        {
            results.AddRange(columnScheduleMembers);
            _logger.LogInformation(
                "Extraction: using {Count} coordinate-resolved schedule rows",
                columnScheduleMembers.Count);
        }
        else if (coordinateDrawingListMembers != null
            && coordinateDrawingListMembers
                .Select(r => r.Mark)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Count() >= 10)
        {
            results.AddRange(coordinateDrawingListMembers);
            _logger.LogInformation(
                "Extraction: using {Count} coordinate-resolved drawing-list rows",
                coordinateDrawingListMembers.Count);
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

        // Preserve the established one-row-per-mark selection for every existing parser.
        results = MergePreferBestRows(results);

        // Numbered schedule rows are intentionally additive and authoritative. They are
        // bounded by a real SCHEDULE title and native PDF columns. Only these trusted rows
        // may preserve multiple Mark + Section definitions (for example pile P1 and purlin
        // P1); all other extraction paths retain their previous merge behaviour.
        if (numberedScheduleMembers is { Count: > 0 })
        {
            results = MergeAuthoritativeNumberedRows(results, numberedScheduleMembers);
            _logger.LogInformation(
                "Extraction: merged {Count} coordinate-resolved numbered schedule rows",
                numberedScheduleMembers.Count);
        }

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

    private sealed record NumberedScheduleTable(
        Word NumberHeader,
        Word ValueHeader,
        Word? NoteHeader,
        string Title,
        double Left,
        double Middle,
        double ValueRight,
        double Right);

    private sealed record NumberedScheduleCandidate(
        double Y,
        string Mark,
        string Value,
        string Source);

    private enum NamedScheduleKind
    {
        SteelMember,
        ConcreteColumn,
        Purlin,
        ConcreteBeam,
        Footing,
    }

    private sealed record HeaderlessNamedScheduleTable(
        double HeaderBottom,
        double Left,
        double Right,
        NamedScheduleKind Kind);

    /// <summary>
    /// Reads boxed, named schedules that contain only data rows beneath the title
    /// (for example STEEL MEMBER SCHEDULE followed immediately by CH083 / 88.9 x
    /// 4.0 CHS). These tables have no MARK/SIZE header row, so the ordinary column
    /// parser cannot discover them. The title and native PDF coordinates keep this
    /// path isolated from drawing callouts elsewhere on the same sheet.
    /// </summary>
    private static List<ExtractedMemberDto> ExtractHeaderlessNamedScheduleRows(
        List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        const double rowTolerance = 4.0;
        const double maximumHeaderLookLeft = 400.0;
        var tables = new List<HeaderlessNamedScheduleTable>();

        foreach (var scheduleWord in pageWords.Where(word =>
                     word.Text.Equals("SCHEDULE", StringComparison.OrdinalIgnoreCase)))
        {
            var headerRow = pageWords
                .Where(word =>
                    Math.Abs(word.BoundingBox.Bottom - scheduleWord.BoundingBox.Bottom)
                        < rowTolerance
                    && word.BoundingBox.Left >= scheduleWord.BoundingBox.Left - maximumHeaderLookLeft
                    && word.BoundingBox.Right <= scheduleWord.BoundingBox.Right + 20)
                .OrderBy(word => word.BoundingBox.Left)
                .ToList();
            var headerText = string.Join(" ", headerRow.Select(word => word.Text))
                .ToUpperInvariant();

            // A few detail notes contain phrases such as "FOOTING SCHEDULE FOR SIZE".
            // They are not schedule-table titles and otherwise leave the parser free to
            // scan the drawing/title block below them. A genuine boxed schedule title
            // ends at SCHEDULE on these consultant sheets.
            var hasTrailingHeaderText = headerRow.Any(word =>
                word.BoundingBox.Left > scheduleWord.BoundingBox.Right + 2
                && word.BoundingBox.Left < scheduleWord.BoundingBox.Right + 100);
            if (hasTrailingHeaderText) continue;

            NamedScheduleKind? kind = headerText switch
            {
                var text when text.Contains("STEEL MEMBER SCHEDULE")
                    => NamedScheduleKind.SteelMember,
                var text when text.Contains("CONCRETE COLUMN SCHEDULE")
                    => NamedScheduleKind.ConcreteColumn,
                var text when text.Contains("PURLIN SCHEDULE")
                    => NamedScheduleKind.Purlin,
                var text when text.Contains("CONCRETE BEAM SCHEDULE")
                    => NamedScheduleKind.ConcreteBeam,
                var text when text.Contains("FOOTING SCHEDULE")
                    => NamedScheduleKind.Footing,
                _ => null,
            };
            if (kind == null) continue;

            var requiredHeaderWords = kind.Value switch
            {
                NamedScheduleKind.SteelMember => new[] { "STEEL", "MEMBER", "SCHEDULE" },
                NamedScheduleKind.ConcreteColumn => new[] { "CONCRETE", "COLUMN", "SCHEDULE" },
                NamedScheduleKind.Purlin => new[] { "PURLIN", "SCHEDULE" },
                NamedScheduleKind.ConcreteBeam => new[] { "CONCRETE", "BEAM", "SCHEDULE" },
                _ => new[] { "FOOTING", "SCHEDULE" },
            };
            var titleWords = headerRow
                .Where(word => requiredHeaderWords.Contains(
                    word.Text.ToUpperInvariant(), StringComparer.OrdinalIgnoreCase))
                .ToList();
            if (titleWords.Count < requiredHeaderWords.Distinct().Count()) continue;

            var headerLeft = titleWords.Min(word => word.BoundingBox.Left);
            var headerRight = titleWords.Max(word => word.BoundingBox.Right);
            var tableLeft = Math.Max(0, headerLeft - 100);
            var tableRight = headerRight + 220;

            // Keep existing MARK/SIZE, ITEM/MEMBER, and TAG/MEMBER schedules on
            // their established parser. This new path is only for missing headers.
            var hasExplicitColumnHeader = pageWords
                .Where(word =>
                    word.BoundingBox.Bottom < scheduleWord.BoundingBox.Bottom - rowTolerance
                    && word.BoundingBox.Bottom > scheduleWord.BoundingBox.Bottom - 70
                    && word.BoundingBox.Left >= tableLeft
                    && word.BoundingBox.Right <= tableRight)
                .GroupBy(word => (int)Math.Round(word.BoundingBox.Bottom / rowTolerance))
                .Select(group => string.Join(" ", group
                    .OrderBy(word => word.BoundingBox.Left)
                    .Select(word => word.Text)).ToUpperInvariant())
                .Any(text =>
                    (text.Contains("MARK") && text.Contains("SIZE"))
                    || (text.Contains("ITEM") && text.Contains("MEMBER"))
                    || (text.Contains("TAG") && text.Contains("MEMBER")));
            if (hasExplicitColumnHeader) continue;

            tables.Add(new HeaderlessNamedScheduleTable(
                scheduleWord.BoundingBox.Bottom,
                tableLeft,
                tableRight,
                kind.Value));
        }

        var results = new List<ExtractedMemberDto>();
        foreach (var table in tables)
        {
            var lowerBoundary = tables
                .Where(candidate =>
                    candidate.HeaderBottom < table.HeaderBottom - rowTolerance
                    && Math.Min(candidate.Right, table.Right)
                        - Math.Max(candidate.Left, table.Left) > 40)
                .Select(candidate => candidate.HeaderBottom)
                .DefaultIfEmpty(double.MinValue)
                .Max();

            var rows = pageWords
                .Where(word =>
                    word.BoundingBox.Bottom < table.HeaderBottom - rowTolerance
                    && word.BoundingBox.Bottom > lowerBoundary + rowTolerance
                    && word.BoundingBox.Bottom > table.HeaderBottom - 800
                    && word.BoundingBox.Left >= table.Left
                    && word.BoundingBox.Right <= table.Right)
                .GroupBy(word => (int)Math.Round(word.BoundingBox.Bottom / rowTolerance))
                .Select(group => group.OrderBy(word => word.BoundingBox.Left).ToList())
                .OrderByDescending(row => row.Max(word => word.BoundingBox.Bottom))
                .ToList();

            // Schedule marks form a stable vertical column. Some reviewed PDFs also
            // contain blue/red markup text over the schedule, including strings that
            // look exactly like member marks. Anchor to the dominant mark-column X so
            // those overlay labels cannot steal the value from the neighbouring row.
            var markColumnCandidates = rows
                .SelectMany(row => row)
                .Where(word => IsHeaderlessNamedScheduleMark(
                    table.Kind, word.Text.Trim().ToUpperInvariant()))
                .Where(word => word.BoundingBox.Left <= table.Left + 170)
                .ToList();
            if (markColumnCandidates.Count == 0) continue;

            var dominantMarkColumnX = markColumnCandidates
                .GroupBy(word => (int)Math.Round(word.BoundingBox.Left / 10.0))
                .OrderByDescending(group => group.Count())
                .First()
                .Average(word => word.BoundingBox.Left);

            foreach (var row in rows)
            {
                var markWord = row
                    .Where(word => word.BoundingBox.Left <= table.Left + 170)
                    .Where(word => Math.Abs(word.BoundingBox.Left - dominantMarkColumnX) <= 25)
                    .Where(word => IsHeaderlessNamedScheduleMark(
                        table.Kind, word.Text.Trim().ToUpperInvariant()))
                    .OrderBy(word => word.BoundingBox.Left)
                    .FirstOrDefault();
                if (markWord == null) continue;

                var value = string.Join(" ", row
                    .Where(word => word.BoundingBox.Left > markWord.BoundingBox.Right + 5)
                    .OrderBy(word => word.BoundingBox.Left)
                    .Select(word => word.Text))
                    .Trim()
                    .Replace('\uFFFD', 'Ø');
                if (value.Length < 2) continue;

                var mark = markWord.Text.Trim().ToUpperInvariant();
                if (!HasHeaderlessNamedScheduleValueEvidence(table.Kind, value)) continue;

                var diameterSection = Regex.Match(value, @"Ø\s*\d{3,4}\b");
                var section = table.Kind == NamedScheduleKind.ConcreteColumn
                    && diameterSection.Success
                    ? NormalizeSection(diameterSection.Value)
                    : NormalizeSection(ExtractGenericScheduleSection(value));
                if (string.IsNullOrWhiteSpace(section)) continue;

                var memberType = table.Kind switch
                {
                    NamedScheduleKind.ConcreteColumn => "Column",
                    NamedScheduleKind.Purlin when mark.StartsWith("G", StringComparison.Ordinal)
                        => "Girt",
                    NamedScheduleKind.Purlin => "Purlin",
                    NamedScheduleKind.ConcreteBeam => "Beam",
                    NamedScheduleKind.Footing => "Footing",
                    NamedScheduleKind.SteelMember when mark.Equals(
                        "FB", StringComparison.OrdinalIgnoreCase) => "Brace",
                    _ => DetectScheduleMemberType(mark, value),
                };

                results.Add(new ExtractedMemberDto(
                    mark,
                    section,
                    memberType,
                    0, 0, 0,
                    $"Schedule row: {mark} = {value}",
                    0.99));
            }
        }

        return results;
    }

    private static bool IsHeaderlessNamedScheduleMark(NamedScheduleKind kind, string mark)
    {
        // The named tables use distinct, conventional mark families. Keeping that
        // knowledge local to this additive parser prevents nearby drawing callouts
        // (A1, C3, REV, JOB, etc.) from being imported as schedule members.
        return kind switch
        {
            NamedScheduleKind.SteelMember => mark.Equals("FB", StringComparison.OrdinalIgnoreCase)
                || Regex.IsMatch(mark,
                    "^" + MarkPrefix + @"[A-Z]{1,4}\d{1,3}[A-Z]?"
                        + CompoundMarkSuffix + @"\*?$",
                    RegexOptions.IgnoreCase),
            NamedScheduleKind.ConcreteColumn => Regex.IsMatch(mark,
                @"^\d{0,2}(?:CC|C)\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase),
            NamedScheduleKind.Purlin => Regex.IsMatch(mark,
                @"^\d{0,2}(?:CJ|FP|G|P)\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase),
            NamedScheduleKind.ConcreteBeam => Regex.IsMatch(mark,
                @"^\d{0,2}(?:CB|B)\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase),
            NamedScheduleKind.Footing => Regex.IsMatch(mark,
                @"^\d{0,2}(?:PF|SF)\d{1,3}[A-Z]?$", RegexOptions.IgnoreCase),
            _ => false,
        };
    }

    private static bool HasHeaderlessNamedScheduleValueEvidence(
        NamedScheduleKind kind,
        string value)
    {
        var hasSteelSection = SteelSectionPattern.IsMatch(value)
            || HollowSectionPattern.IsMatch(value)
            || PurlinSectionPattern.IsMatch(value)
            || ZPurlinSectionPattern.IsMatch(value)
            || PlainZPurlinSectionPattern.IsMatch(value)
            || RodBracingPattern.IsMatch(value);
        var hasCircularHollowSection = Regex.IsMatch(value,
            @"\b\d{2,4}(?:\.\d+)?\s*[xX×]\s*\d{1,2}(?:\.\d+)?\s*CHS\b",
            RegexOptions.IgnoreCase);
        var hasConcreteSize = ConcreteDimPattern.IsMatch(value)
            || Regex.IsMatch(value,
                @"(?:\b\d{3,4}\s*(?:DIA|Ø)\b|(?:Ø|�)\s*\d{3,4}\b)",
                RegexOptions.IgnoreCase);
        var hasSpacedPurlinSection = Regex.IsMatch(value,
            @"\b[CZ]\s*\d{3}\s*\d{1,2}\b", RegexOptions.IgnoreCase);

        return kind switch
        {
            NamedScheduleKind.SteelMember => hasSteelSection
                || hasCircularHollowSection
                || value.Contains("FLY BRACE", StringComparison.OrdinalIgnoreCase),
            NamedScheduleKind.ConcreteColumn => hasConcreteSize,
            NamedScheduleKind.Purlin => hasSteelSection || hasSpacedPurlinSection,
            NamedScheduleKind.ConcreteBeam => hasConcreteSize,
            NamedScheduleKind.Footing => hasConcreteSize,
            _ => false,
        };
    }

    /// <summary>
    /// Reads ordinary two-column schedules when their native PDF text exposes aligned
    /// MARK/SIZE, ITEM/MEMBER, or TAG/MEMBER headers. Geometry keeps adjacent schedule
    /// columns separate (the TAG/MEMBER form is used by the HV purlin schedule).
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
            ("ITEM", "MEMBER"),
            ("TAG", "MEMBER")
        })
        {
            // TAG/MEMBER is intentionally limited to an actual PURLIN SCHEDULE
            // or GIRT SCHEDULE header. Other drawing tables can contain a generic TAG
            // column, and treating those as member schedules would change the existing
            // parser's source-selection behaviour. The existing PURLIN check remains
            // unchanged; GIRT is an additive equivalent for the same table layout.
            if (markHeaderText.Equals("TAG", StringComparison.OrdinalIgnoreCase)
                && !HasNearbyPurlinScheduleHeader(pageWords)
                && !HasNearbyGirtScheduleHeader(pageWords))
                continue;

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

                if (row.Mark is "MARK" or "ITEM" or "TAG" or "SIZE" or "MEMBER"
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
    /// Reads schedules whose first column is headed No. and whose remaining columns are
    /// MEMBER/SIZE and NOTE/COMMENTS. These tables are common for piles, purlins, rafters,
    /// and beams. Requiring a nearby SCHEDULE title and using the native PDF X coordinates
    /// prevents plan labels on the same visual row from leaking into the section size.
    /// </summary>
    private static List<ExtractedMemberDto> ExtractNumberedScheduleRows(List<Word> pageWords)
    {
        if (pageWords.Count == 0) return [];

        const double rowTolerance = 4.0;
        const double markColumnTolerance = 25.0;
        var numberHeaders = pageWords
            .Where(word => Regex.IsMatch(word.Text.Trim(), @"^NO\.?$", RegexOptions.IgnoreCase))
            .OrderByDescending(word => word.BoundingBox.Bottom)
            .ThenBy(word => word.BoundingBox.Left)
            .ToList();
        var tables = new List<NumberedScheduleTable>();

        foreach (var numberHeader in numberHeaders)
        {
            var valueHeader = pageWords
                .Where(word =>
                    (word.Text.Equals("MEMBER", StringComparison.OrdinalIgnoreCase)
                        || word.Text.Equals("SIZE", StringComparison.OrdinalIgnoreCase))
                    && Math.Abs(word.BoundingBox.Bottom - numberHeader.BoundingBox.Bottom)
                        < rowTolerance
                    && word.BoundingBox.Left > numberHeader.BoundingBox.Left)
                .OrderBy(word => word.BoundingBox.Left)
                .FirstOrDefault();
            if (valueHeader == null) continue;

            var noteHeader = pageWords
                .Where(word =>
                    (word.Text.Equals("NOTE", StringComparison.OrdinalIgnoreCase)
                        || word.Text.Equals("NOTES", StringComparison.OrdinalIgnoreCase)
                        || word.Text.Equals("COMMENTS", StringComparison.OrdinalIgnoreCase)
                        || word.Text.Equals("REINFORCEMENT", StringComparison.OrdinalIgnoreCase))
                    && Math.Abs(word.BoundingBox.Bottom - numberHeader.BoundingBox.Bottom)
                        < rowTolerance
                    && word.BoundingBox.Left > valueHeader.BoundingBox.Left)
                .OrderBy(word => word.BoundingBox.Left)
                .FirstOrDefault();

            var scheduleWord = pageWords
                .Where(word => word.Text.Equals("SCHEDULE", StringComparison.OrdinalIgnoreCase)
                    && word.BoundingBox.Bottom > numberHeader.BoundingBox.Bottom + rowTolerance
                    && word.BoundingBox.Bottom < numberHeader.BoundingBox.Bottom + 120
                    && word.BoundingBox.Left > numberHeader.BoundingBox.Left - 180
                    && word.BoundingBox.Left < (noteHeader?.BoundingBox.Right
                        ?? valueHeader.BoundingBox.Right) + 220)
                .OrderBy(word => word.BoundingBox.Bottom - numberHeader.BoundingBox.Bottom)
                .FirstOrDefault();
            if (scheduleWord == null) continue;

            var title = string.Join(" ", pageWords
                .Where(word => Math.Abs(word.BoundingBox.Bottom - scheduleWord.BoundingBox.Bottom)
                        < rowTolerance
                    && word.BoundingBox.Left >= numberHeader.BoundingBox.Left - 180
                    && word.BoundingBox.Right <= scheduleWord.BoundingBox.Right + 20)
                .OrderBy(word => word.BoundingBox.Left)
                .Select(word => word.Text))
                .Trim()
                .ToUpperInvariant();
            if (!title.Contains("SCHEDULE", StringComparison.OrdinalIgnoreCase)) continue;

            var nextHeaderX = numberHeaders
                .Where(header => Math.Abs(
                        header.BoundingBox.Bottom - numberHeader.BoundingBox.Bottom) < rowTolerance
                    && header.BoundingBox.Left > numberHeader.BoundingBox.Left)
                .Select(header => header.BoundingBox.Left)
                .DefaultIfEmpty(double.MaxValue)
                .Min();
            var columnDistance = valueHeader.BoundingBox.Left - numberHeader.BoundingBox.Left;
            var valueRight = noteHeader != null
                ? (valueHeader.BoundingBox.Left + noteHeader.BoundingBox.Left) / 2.0
                : valueHeader.BoundingBox.Left + Math.Max(100, columnDistance * 4);
            var right = nextHeaderX < double.MaxValue
                ? nextHeaderX - 8
                : noteHeader != null
                    ? noteHeader.BoundingBox.Left + Math.Max(
                        120, (noteHeader.BoundingBox.Left - valueHeader.BoundingBox.Left) * 1.6)
                    : valueRight;

            tables.Add(new NumberedScheduleTable(
                numberHeader,
                valueHeader,
                noteHeader,
                title,
                numberHeader.BoundingBox.Left - markColumnTolerance,
                (numberHeader.BoundingBox.Left + valueHeader.BoundingBox.Left) / 2.0,
                valueRight,
                right));
        }

        var results = new List<ExtractedMemberDto>();
        foreach (var table in tables)
        {
            var lowerHeaderBoundary = tables
                .Where(candidate =>
                    candidate.NumberHeader.BoundingBox.Bottom
                        < table.NumberHeader.BoundingBox.Bottom - rowTolerance
                    && Math.Min(candidate.Right, table.Right)
                        - Math.Max(candidate.Left, table.Left) > 20)
                .Select(candidate => candidate.NumberHeader.BoundingBox.Bottom)
                .DefaultIfEmpty(table.NumberHeader.BoundingBox.Bottom - 400)
                .Max();

            var candidateRows = pageWords
                .Where(word =>
                    word.BoundingBox.Bottom
                        < table.NumberHeader.BoundingBox.Bottom - rowTolerance
                    && word.BoundingBox.Bottom > lowerHeaderBoundary + rowTolerance
                    && word.BoundingBox.Left > table.Left
                    && word.BoundingBox.Left < table.Right)
                .GroupBy(word => (int)Math.Round(word.BoundingBox.Bottom / rowTolerance))
                .Select(group => group.OrderBy(word => word.BoundingBox.Left).ToList())
                .Select(row =>
                {
                    var markWord = row
                        .Where(word => Math.Abs(
                                word.BoundingBox.Left
                                    - table.NumberHeader.BoundingBox.Left)
                                < markColumnTolerance
                            && Regex.IsMatch(word.Text.Trim(),
                                "^" + MarkPrefix + @"[A-Z]{1,5}[A-Z0-9]{0,4}"
                                    + CompoundMarkSuffix + @"\*?$",
                                RegexOptions.IgnoreCase))
                        .OrderBy(word => Math.Abs(
                            word.BoundingBox.Left - table.NumberHeader.BoundingBox.Left))
                        .FirstOrDefault();
                    if (markWord == null) return null;

                    var value = string.Join(" ", row
                        .Where(word =>
                        {
                            var center = (word.BoundingBox.Left + word.BoundingBox.Right) / 2.0;
                            return center >= table.Middle && center < table.ValueRight;
                        })
                        .OrderBy(word => word.BoundingBox.Left)
                        .Select(word => word.Text))
                        .Trim()
                        .Replace('\uFFFD', 'Ø');
                    if (value.Length < 2) return null;

                    var source = string.Join(" ", row
                        .Where(word =>
                        {
                            var center = (word.BoundingBox.Left + word.BoundingBox.Right) / 2.0;
                            return center >= table.Left && center < table.Right;
                        })
                        .OrderBy(word => word.BoundingBox.Left)
                        .Select(word => word.Text))
                        .Trim()
                        .Replace('\uFFFD', 'Ø');

                    return new NumberedScheduleCandidate(
                        markWord.BoundingBox.Bottom,
                        markWord.Text.Trim().ToUpperInvariant(),
                        value,
                        source);
                })
                .Where(candidate => candidate != null)
                .Select(candidate => candidate!)
                .OrderByDescending(candidate => candidate.Y)
                .ToList();

            for (var index = 0; index < candidateRows.Count; index++)
            {
                var row = candidateRows[index];
                var section = ExtractNumberedScheduleSection(row.Value);
                if (string.IsNullOrWhiteSpace(section)) continue;

                var source = row.Source;
                if (table.NoteHeader != null)
                {
                    var nextRowY = index + 1 < candidateRows.Count
                        ? candidateRows[index + 1].Y
                        : row.Y - 30;
                    var continuation = string.Join(" ", pageWords
                        .Where(word => word.BoundingBox.Bottom < row.Y - rowTolerance
                            && word.BoundingBox.Bottom > Math.Max(nextRowY + rowTolerance, row.Y - 30)
                            && word.BoundingBox.Left >= table.NoteHeader.BoundingBox.Left - 10
                            && word.BoundingBox.Left < table.Right)
                        .OrderByDescending(word => word.BoundingBox.Bottom)
                        .ThenBy(word => word.BoundingBox.Left)
                        .Select(word => word.Text))
                        .Trim();
                    if (continuation.Length > 0)
                        source = $"{source} {continuation}";
                }

                source = Regex.Replace(source, @"\s+", " ").Trim();
                var memberType = table.Title.Contains("PILE", StringComparison.OrdinalIgnoreCase)
                    ? "Other"
                    : table.Title.Contains("GIRT", StringComparison.OrdinalIgnoreCase)
                        || row.Mark.StartsWith("G", StringComparison.OrdinalIgnoreCase)
                        ? "Girt"
                        : table.Title.Contains("PURLIN", StringComparison.OrdinalIgnoreCase)
                            ? "Purlin"
                            : DetectMemberType(row.Mark, section);

                results.Add(new ExtractedMemberDto(
                    row.Mark,
                    section,
                    memberType,
                    0, 0, 0,
                    $"Schedule row: {source}",
                    1.0));
            }
        }

        return results;
    }

    private static string ExtractNumberedScheduleSection(string value)
    {
        var match = SteelSectionPattern.Match(value);
        if (!match.Success) match = HollowSectionPattern.Match(value);
        if (!match.Success) match = PlainZPurlinSectionPattern.Match(value);
        if (!match.Success) match = ZPurlinSectionPattern.Match(value);
        if (!match.Success) match = PurlinSectionPattern.Match(value);
        if (!match.Success) match = DiameterSectionPattern.Match(value);
        if (!match.Success) match = ConcreteDimPattern.Match(value);
        if (!match.Success) match = RodBracingPattern.Match(value);
        return match.Success ? NormalizeSection(match.Value) : string.Empty;
    }

    private static bool HasNearbyPurlinScheduleHeader(List<Word> pageWords)
    {
        var purlinHeaders = pageWords
            .Where(w => w.Text.Equals("PURLIN", StringComparison.OrdinalIgnoreCase))
            .ToList();
        return purlinHeaders.Any(p => pageWords.Any(s =>
            s.Text.Equals("SCHEDULE", StringComparison.OrdinalIgnoreCase)
            && Math.Abs(s.BoundingBox.Bottom - p.BoundingBox.Bottom) < 80
            && Math.Abs(s.BoundingBox.Left - p.BoundingBox.Right) < 120));
    }

    private static bool HasNearbyGirtScheduleHeader(List<Word> pageWords)
    {
        var girtHeaders = pageWords
            .Where(w => w.Text.Equals("GIRT", StringComparison.OrdinalIgnoreCase))
            .ToList();
        return girtHeaders.Any(g => pageWords.Any(s =>
            s.Text.Equals("SCHEDULE", StringComparison.OrdinalIgnoreCase)
            && Math.Abs(s.BoundingBox.Bottom - g.BoundingBox.Bottom) < 80
            && Math.Abs(s.BoundingBox.Left - g.BoundingBox.Right) < 120));
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
                || ZPurlinSectionPattern.IsMatch(r.MemberSize)
                || PlainZPurlinSectionPattern.IsMatch(r.MemberSize)
                || DiameterSectionPattern.IsMatch(r.MemberSize)
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
            || ZPurlinSectionPattern.IsMatch(r.MemberSize)
            || PlainZPurlinSectionPattern.IsMatch(r.MemberSize)
            || DiameterSectionPattern.IsMatch(r.MemberSize)
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
                    || PurlinSectionPattern.IsMatch(line)
                    || ZPurlinSectionPattern.IsMatch(line)
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

    private static List<ExtractedMemberDto> MergeAuthoritativeNumberedRows(
        List<ExtractedMemberDto> existingRows,
        List<ExtractedMemberDto> numberedRows)
    {
        var authoritative = new Dictionary<string, ExtractedMemberDto>(
            StringComparer.OrdinalIgnoreCase);
        foreach (var row in numberedRows)
        {
            var markKey = NormalizeExtractionIdentity(row.Mark);
            var sectionKey = NormalizeExtractionIdentity(row.MemberSize);
            if (markKey.Length == 0 || sectionKey.Length == 0) continue;

            var key = $"{markKey}|{sectionKey}";
            if (!authoritative.TryGetValue(key, out var current)
                || row.Description.Length > current.Description.Length)
                authoritative[key] = row;
        }

        var authoritativeRows = authoritative.Values.ToList();

        // Keep the established number of extracted members. Coordinate rows are evidence
        // used to correct an existing row's mark, section and source; they must not delete
        // legitimate level-prefixed marks (for example 1C9) or add extra rows.
        return existingRows.Select(candidate =>
        {
            var candidateMark = NormalizeExtractionIdentity(candidate.Mark);
            var candidateSection = NormalizeExtractionIdentity(candidate.MemberSize);

            var exactMatches = authoritativeRows
                .Where(row => NormalizeExtractionIdentity(row.Mark)
                    .Equals(candidateMark, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (exactMatches.Count > 0)
            {
                return exactMatches.FirstOrDefault(row =>
                        NormalizeExtractionIdentity(row.MemberSize).Equals(
                            candidateSection,
                            StringComparison.OrdinalIgnoreCase))
                    ?? exactMatches[0];
            }

            // Repair only a proven glued prefix: the canonical table mark must be a suffix
            // and either its section exactly matches or the reconstructed value has no
            // structural-section evidence at all (for example "1C1 5 S STAIR S"). A clean
            // row such as "1C9 75x3.0 SHS" therefore remains untouched. The row stays in
            // place, so extraction count and all unrelated schedule logic are unchanged.
            var hasRecognizedCandidateSection = HasRecognizedSectionEvidence(
                candidate.MemberSize);
            var corrected = authoritativeRows.FirstOrDefault(row =>
                IsNumericPrefixContamination(
                    candidateMark,
                    NormalizeExtractionIdentity(row.Mark))
                && (NormalizeExtractionIdentity(row.MemberSize).Equals(
                        candidateSection,
                        StringComparison.OrdinalIgnoreCase)
                    || !hasRecognizedCandidateSection));
            return corrected ?? candidate;
        }).ToList();
    }

    private static bool HasRecognizedSectionEvidence(string value)
        => SteelSectionPattern.IsMatch(value)
            || HollowSectionPattern.IsMatch(value)
            || ReidBarPattern.IsMatch(value)
            || ConcreteDimPattern.IsMatch(value)
            || PurlinSectionPattern.IsMatch(value)
            || ZPurlinSectionPattern.IsMatch(value)
            || PlainZPurlinSectionPattern.IsMatch(value)
            || DiameterSectionPattern.IsMatch(value)
            || RodBracingPattern.IsMatch(value);

    private static bool IsNumericPrefixContamination(string candidateMark, string canonicalMark)
    {
        if (canonicalMark.Length == 0
            || candidateMark.Length <= canonicalMark.Length
            || !candidateMark.EndsWith(canonicalMark, StringComparison.OrdinalIgnoreCase))
            return false;

        var extraPrefix = candidateMark[..^canonicalMark.Length];
        return Regex.IsMatch(extraPrefix, @"^[0-9O]+$", RegexOptions.IgnoreCase);
    }

    private static string NormalizeExtractionIdentity(string value)
        => Regex.Replace(value ?? string.Empty, @"[^A-Z0-9Ø]+", string.Empty,
            RegexOptions.IgnoreCase).ToUpperInvariant();

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
                           || PurlinSectionPattern.IsMatch(line) || ZPurlinSectionPattern.IsMatch(line)
                           || PlainZPurlinSectionPattern.IsMatch(line)
                           || DiameterSectionPattern.IsMatch(line)
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
        if (!sectionMatch.Success) sectionMatch = ZPurlinSectionPattern.Match(line);
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
        if (!sectionMatch.Success) sectionMatch = ZPurlinSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = PlainZPurlinSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = RodBracingPattern.Match(rest);
        if (sectionMatch.Success) return NormalizeSection(sectionMatch.Value.Trim());

        var diameterMatch = DiameterSectionPattern.Match(rest);
        if (diameterMatch.Success) return NormalizeSection(diameterMatch.Value.Trim());

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

            foreach (Match zpm in ZPurlinSectionPattern.Matches(line))
            {
                if (IsNoisePatternLine(line, zpm)) continue;
                TryAddPatternRow(results, line, zpm);
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

        var plainZ = Regex.Match(trimmed, @"^E?Z\s*(\d{3,5})$", RegexOptions.IgnoreCase);
        if (plainZ.Success)
        {
            var prefix = trimmed.TrimStart().StartsWith("EZ", StringComparison.OrdinalIgnoreCase)
                ? "EZ"
                : "Z";
            return $"{prefix}{plainZ.Groups[1].Value}".ToUpperInvariant();
        }

        var diameter = DiameterSectionPattern.Match(trimmed);
        if (diameter.Success && diameter.Index == 0 && diameter.Length == trimmed.Length)
        {
            var number = Regex.Match(diameter.Value, @"\d{2,4}").Value;
            return $"{number}mm DIA";
        }

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
