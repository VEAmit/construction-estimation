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

    // Weight suffix optional → matches "310 UB 40.4" AND "200 PFC"
    private static readonly Regex SteelSectionPattern = new(
        @"\b(\d{2,4})\s*(UB|UC|PFC|TFC|CHS|RHS|SHS|EA|UA|RSJ|WB|WC|TFB|BFB|HRS)\s*(\d{1,3}(?:\.\d+)?)?\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static readonly Regex HollowSectionPattern = new(
        @"\b(\d{2,3})[xX×](\d{2,3})(?:[xX×](\d{1,2}(?:\.\d+)?))?\s*(RHS|SHS|CHS|EA|UA)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static readonly Regex MemberMarkPattern = new(
        @"\b([RBCPGFHKM][1-9][0-9]?)\b",
        RegexOptions.Compiled
    );

    private static readonly string[] ScheduleHeaders = {
        "member schedule", "steel schedule", "section schedule",
        "beam schedule", "column schedule", "purlin schedule",
        "member mark", "section size", "unit weight",
    };

    private static readonly Dictionary<string, double> SectionWeights =
        new(StringComparer.OrdinalIgnoreCase)
        {
            {"150UB14.0",14.0},{"150UB18.0",18.0},
            {"180UB16.1",16.1},{"180UB18.1",18.1},{"180UB22.2",22.2},
            {"200UB18.2",18.2},{"200UB22.3",22.3},{"200UB25.4",25.4},{"200UB29.8",29.8},
            {"250UB25.7",25.7},{"250UB31.4",31.4},{"250UB37.3",37.3},
            {"310UB32.0",32.0},{"310UB40.4",40.4},{"310UB46.2",46.2},
            {"360UB44.7",44.7},{"360UB50.7",50.7},{"360UB56.7",56.7},
            {"410UB53.7",53.7},{"410UB59.7",59.7},
            {"460UB67.1",67.1},{"460UB74.6",74.6},{"460UB82.1",82.1},
            {"530UB82.0",82.0},{"530UB92.4",92.4},
            {"610UB101",101.0},{"610UB113",113.0},{"610UB125",125.0},
            {"100UC14.8",14.8},
            {"150UC23.4",23.4},{"150UC30.0",30.0},{"150UC37.2",37.2},
            {"200UC46.2",46.2},{"200UC52.2",52.2},{"200UC59.5",59.5},
            {"250UC72.9",72.9},{"250UC89.5",89.5},
            {"310UC96.8",96.8},{"310UC118",118.0},{"310UC137",137.0},
            {"360UC144",144.0},{"360UC179",179.0},
            {"75PFC",5.92},{"100PFC",8.33},{"125PFC",11.9},{"150PFC",17.7},
            {"180PFC",22.2},{"200PFC",29.9},{"230PFC",36.0},{"250PFC",35.5},
            {"300PFC",46.0},{"380PFC",55.0},
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
                    allLines.AddRange(ReconstructLines(words));
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

            _logger.LogInformation(
                "Drawing {DrawingId}: extraction method={Method}, lines={Lines}",
                drawingId, extractionMethod, allLines.Count);

            var fullText = string.Join(" ", allLines);
            var members = ParseMembers(allLines, fullText);

            var rawSample = allLines
                .Where(l => l.Length > 3)
                .Take(40)
                .ToList();

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

    private static List<string> ReconstructLines(List<Word> words)
    {
        if (words.Count == 0) return [];

        const double tolerance = 3.0;
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

    // ── Member parsing ───────────────────────────────────────────────────────────

    private List<ExtractedMemberDto> ParseMembers(List<string> lines, string fullText)
    {
        var results = new List<ExtractedMemberDto>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var scheduleStart = FindScheduleSection(lines);
        if (scheduleStart >= 0)
        {
            foreach (var m in ParseScheduleTable(lines, scheduleStart))
                if (seen.Add($"{m.Mark}|{m.MemberSize}")) results.Add(m);
        }

        foreach (var m in ParseByPattern(lines, fullText))
            if (seen.Add($"{m.Mark}|{m.MemberSize}")) results.Add(m);

        return results;
    }

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
        var categoryCounters = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        string currentCategory = "Other";
        string currentPrefix = "M";

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

        for (int i = headerIdx + 1; i < lines.Count; i++)
        {
            var line = lines[i].Trim();
            if (line.Length < 2) continue;
            if (IsStopLine(line) && i > headerIdx + 3) break;

            if (IsSubHeader(line))
            {
                currentCategory = line.Trim();
                currentPrefix = GetMarkPrefix(currentCategory);
                continue;
            }

            var member = TryParseScheduleRow(line, currentPrefix, categoryCounters);
            if (member != null) results.Add(member);
        }

        return results;
    }

    private static string GetMarkPrefix(string category)
    {
        var upper = category.ToUpperInvariant();
        if (upper.Contains("RAFTER")) return "R";
        if (upper.Contains("ROOF BEAM") || upper.Contains("FLOOR BEAM")) return "B";
        if (upper.Contains("BEAM")) return "B";
        if (upper.Contains("COLUMN") || upper.Contains("POST")) return "C";
        if (upper.Contains("PURLIN")) return "P";
        if (upper.Contains("GIRT")) return "G";
        if (upper.Contains("BRACE")) return "K";
        if (upper.Contains("FASCIA")) return "F";
        return "M";
    }

    private static bool IsStopLine(string line)
    {
        var lower = line.ToLowerInvariant();
        return lower.StartsWith("note") || lower.StartsWith("general")
            || lower.StartsWith("drawing") || lower.StartsWith("detail");
    }

    private static readonly HashSet<string> SubHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "RAFTERS","BEAMS","COLUMNS","PURLINS","GIRTS","BRACES",
            "FLOOR BEAMS","ROOF BEAMS","PORTAL FRAMES","SECONDARY MEMBERS"
        };

    private static bool IsSubHeader(string line) => SubHeaders.Contains(line.Trim());

    private ExtractedMemberDto? TryParseScheduleRow(
        string line,
        string categoryPrefix = "M",
        Dictionary<string, int>? counters = null)
    {
        var sectionMatch = SteelSectionPattern.Match(line);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(line);
        if (!sectionMatch.Success) return null;

        // Use extracted mark if present, otherwise auto-assign from category
        var markMatch = MemberMarkPattern.Match(line);
        string mark;
        if (markMatch.Success)
        {
            mark = markMatch.Value;
        }
        else
        {
            counters ??= new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            if (!counters.TryGetValue(categoryPrefix, out var seq)) seq = 0;
            seq++;
            counters[categoryPrefix] = seq;
            mark = $"{categoryPrefix}{seq}";
        }

        var sectionRaw = sectionMatch.Value.Trim();
        var memberType = DetectMemberType(mark, sectionRaw);
        var unitWeight = LookupUnitWeight(sectionRaw);

        double length = 0; int qty = 1;
        ExtractLengthAndQty(line, ref length, ref qty);

        return new ExtractedMemberDto(
            mark, NormalizeSection(sectionRaw), memberType,
            unitWeight, length, qty,
            $"Schedule: {TruncateLine(line)}",
            0.90
        );
    }

    private List<ExtractedMemberDto> ParseByPattern(List<string> lines, string fullText)
    {
        var results = new List<ExtractedMemberDto>();
        var counters = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        string currentPrefix = "M";

        foreach (var line in lines)
        {
            // Track sub-headers to infer mark prefix for upcoming pattern-matched rows
            if (IsSubHeader(line))
            {
                currentPrefix = GetMarkPrefix(line.Trim());
                continue;
            }

            foreach (Match sm in SteelSectionPattern.Matches(line))
            {
                var markMatch = MemberMarkPattern.Match(line);
                string mark;
                if (markMatch.Success)
                {
                    mark = markMatch.Value;
                }
                else
                {
                    // Auto-assign using context prefix
                    var prefix = string.IsNullOrEmpty(InferMarkFromContext(line, sm.Value).TrimEnd('?'))
                        ? currentPrefix
                        : InferMarkFromContext(line, sm.Value).TrimEnd('?');
                    if (!counters.TryGetValue(prefix, out var seq)) seq = 0;
                    seq++;
                    counters[prefix] = seq;
                    mark = $"{prefix}{seq}";
                }

                var sectionRaw = sm.Value.Trim();
                var memberType = DetectMemberType(mark, sectionRaw);
                var unitWeight = LookupUnitWeight(sectionRaw);

                double length = 0; int qty = 1;
                ExtractLengthAndQty(line, ref length, ref qty);
                if (length == 0) length = InferDefaultLength(memberType);

                results.Add(new ExtractedMemberDto(
                    mark, NormalizeSection(sectionRaw), memberType,
                    unitWeight, length, qty,
                    $"Pattern: {TruncateLine(line)}",
                    0.70
                ));
            }
        }

        return results;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    private static void ExtractLengthAndQty(string line, ref double length, ref int qty)
    {
        var qtyMatch = Regex.Match(line, @"(?:qty|x|×|\/)\s*(\d{1,2})\s*(?:off|nr|no\.?|pcs)?",
            RegexOptions.IgnoreCase);
        if (qtyMatch.Success && int.TryParse(qtyMatch.Groups[1].Value, out var q) && q is >= 1 and <= 99)
            qty = q;

        var mmMatch = Regex.Match(line, @"\b(\d{3,5})\s*mm\b", RegexOptions.IgnoreCase);
        if (mmMatch.Success && double.TryParse(mmMatch.Groups[1].Value, out var mm))
        { length = Math.Round(mm / 1000.0, 3); return; }

        var mMatch = Regex.Match(line, @"\b(\d{1,2}(?:\.\d{1,3})?)\s*m\b", RegexOptions.IgnoreCase);
        if (mMatch.Success && double.TryParse(mMatch.Groups[1].Value, out var m))
        { length = m; return; }

        var bareMatch = Regex.Match(line, @"\b(\d{4,5})\b");
        if (bareMatch.Success && double.TryParse(bareMatch.Groups[1].Value, out var bare)
            && bare is >= 1000 and <= 25000)
            length = Math.Round(bare / 1000.0, 3);
    }

    private static string DetectMemberType(string mark, string section)
    {
        var m = mark.ToUpperInvariant();
        var s = section.ToUpperInvariant();
        if (m.StartsWith("B")) return "Beam";
        if (m.StartsWith("C") || s.Contains("UC")) return "Column";
        if (m.StartsWith("R") || m.StartsWith("F")) return "Rafter";
        if (m.StartsWith("P") || s.Contains("PFC")) return "Purlin";
        if (m.StartsWith("G")) return "Girt";
        if (m.StartsWith("K") || m.StartsWith("H")) return "Brace";
        if (s.Contains("RHS") || s.Contains("SHS") || s.Contains("CHS")) return "Brace";
        if (s.Contains("UB")) return "Beam";
        return "Other";
    }

    private static double LookupUnitWeight(string section)
    {
        var normalized = NormalizeSection(section);
        if (SectionWeights.TryGetValue(normalized, out var w)) return w;
        if (SectionWeights.TryGetValue(normalized.Replace(" ", ""), out var w2)) return w2;
        var m = Regex.Match(normalized, @"(UB|UC)\s*(\d{1,3}(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (m.Success && double.TryParse(m.Groups[2].Value, out var wt)) return wt;
        return 0;
    }

    private static string NormalizeSection(string raw)
        => Regex.Replace(raw.Trim(), @"\s+", "").ToUpperInvariant();

    private static string InferMarkFromContext(string line, string _)
    {
        var upper = line.ToUpperInvariant();
        if (upper.Contains("RAFTER") || upper.Contains("ROOF")) return "R?";
        if (upper.Contains("BEAM")) return "B?";
        if (upper.Contains("COLUMN") || upper.Contains("POST")) return "C?";
        if (upper.Contains("PURLIN")) return "P?";
        if (upper.Contains("GIRT")) return "G?";
        if (upper.Contains("BRACE")) return "K?";
        return "?";
    }

    private static double InferDefaultLength(string memberType) => memberType switch
    {
        "Rafter" => 6.0,
        "Beam"   => 6.0,
        "Column" => 3.6,
        "Purlin" => 6.0,
        "Girt"   => 6.0,
        "Brace"  => 3.0,
        _        => 0
    };

    private static string TruncateLine(string line)
        => line.Length > 60 ? line[..60] + "..." : line;
}
