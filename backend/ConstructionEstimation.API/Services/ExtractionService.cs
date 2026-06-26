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
        @"\b(\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*[xX×]\s*(\d{1,2}(?:\.\d+)?))?\s*(RHS|SHS|CHS|EA|UA)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Reid bars on precast plans — "R1 - RB12 REID BARS x 540 LONG..."
    private static readonly Regex ReidBarPattern = new(
        @"\b(RB\d+)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Marks as shown on drawings: SC2, B1, C7, FB1 — UB/UC or hollow (75 x 5 SHS)
    private static readonly Regex PdfScheduleMarkPattern = new(
        @"\b([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—]\s*(?:\d+\s*)?(?:(?:\d+\s*[xX×]\s*)+\d+(?:\.\d+)?\s*)?(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS|RB\d+)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Table row: mark then section at line start — "SC2  360UB45" or "B1 610 UB 113"
    private static readonly Regex TableRowMarkPattern = new(
        @"^\s*([A-Z]{1,4}\d{0,3}[A-Z]?)\s+\d{2,4}\s*(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    // Drawing list format (COLUMNS / BEAMS / PAD FOOTINGS on structural plans)
    private static readonly Regex DrawingListLinePattern = new(
        @"^\s*([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:]\s*(.+)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled
    );

    private static readonly string[] DrawingListSections = {
        "COLUMNS", "BEAMS", "RAFTERS", "PURLINS", "GIRTS", "BRACES",
        "FLOOR BEAMS", "FLOORBEAMS", "ROOF BEAMS", "PAD FOOTINGS", "STRUTS",
        "SECONDARY MEMBERS", "OTHERS", "OTHER",
    };

    private static readonly string[] ScheduleHeaders = {
        "member schedule", "steel schedule", "section schedule",
        "beam schedule", "column schedule", "purlin schedule",
        "member mark", "section size", "unit weight",
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

        // COLUMNS / BEAMS lists on footing plans (SC2 - 360 UB 45, C1 - 610 UB 113)
        results.AddRange(ParseDrawingLists(lines));

        var scheduleStart = FindScheduleSection(lines);
        if (scheduleStart >= 0)
            results.AddRange(ParseScheduleTable(lines, scheduleStart));

        results.AddRange(ParseByPattern(lines, fullText));

        // One row per mark — prefer drawing list > schedule > pattern
        results = MergePreferBestRows(results);
        return results.Where(IsValidExtractedMember)
            .OrderBy(r => r.Mark, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Only rows with a real PDF mark + section — drops note lines (PROVIDE, REINFORCEMENT, etc.).</summary>
    private static bool IsValidExtractedMember(ExtractedMemberDto r)
    {
        if (string.IsNullOrWhiteSpace(r.Mark) || string.IsNullOrWhiteSpace(r.MemberSize))
            return false;
        if (!Regex.IsMatch(r.Mark, @"^[A-Z]{1,4}\d{0,3}[A-Z]?$", RegexOptions.IgnoreCase))
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
            || (r.Confidence >= 0.95 && r.MemberSize.Length >= 2);
    }

    /// <summary>
    /// Parses COLUMNS, BEAMS, PAD FOOTINGS blocks — "SC2 - 360 UB 45: REFER TO DETAIL..."
    /// </summary>
    private List<ExtractedMemberDto> ParseDrawingLists(List<string> lines)
    {
        var results = new List<ExtractedMemberDto>();
        bool inList = false;

        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length < 2) continue;

            if (IsDrawingListHeader(line))
            {
                inList = true;
                continue;
            }

            if (inList && (IsStopLine(line) || IsDrawingListHeader(line)))
            {
                inList = false;
                if (IsDrawingListHeader(line)) inList = true;
            }

            ExtractedMemberDto? member = null;
            if (inList)
                member = TryParseDrawingListLine(line);
            else if (DrawingListLinePattern.IsMatch(line))
                member = TryParseDrawingListLine(line);

            if (member != null) results.Add(member);
        }

        return results;
    }

    private static bool IsDrawingListHeader(string line)
    {
        var upper = line.Trim().ToUpperInvariant();
        var compact = upper.Replace(" ", "");
        return DrawingListSections.Any(s =>
        {
            var section = s.ToUpperInvariant();
            var sectionCompact = section.Replace(" ", "");
            return upper == section || upper.StartsWith(section + " ", StringComparison.Ordinal)
                || compact == sectionCompact || compact.StartsWith(sectionCompact, StringComparison.Ordinal);
        });
    }

    private ExtractedMemberDto? TryParseDrawingListLine(string line)
    {
        var listMatch = DrawingListLinePattern.Match(line);
        if (!listMatch.Success) return null;

        var mark = listMatch.Groups[1].Value.ToUpperInvariant();
        var rest = listMatch.Groups[2].Value.Trim();

        // Drop trailing note after colon — "360 UB 45: REFER TO DETAIL..."
        var noteIdx = rest.IndexOf(':');
        if (noteIdx > 0) rest = rest[..noteIdx].Trim();

        var sectionMatch = SteelSectionPattern.Match(rest);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(rest);
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

        for (int i = headerIdx + 1; i < lines.Count; i++)
        {
            var line = lines[i].Trim();
            if (line.Length < 2) continue;
            if (IsStopLine(line) && i > headerIdx + 3) break;

            if (IsSubHeader(line)) continue;

            var member = TryParseScheduleRow(line);
            if (member != null) results.Add(member);
        }

        return results;
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
            "FLOOR BEAMS","FLOORBEAMS","ROOF BEAMS","PORTAL FRAMES",
            "SECONDARY MEMBERS","OTHERS","OTHER"
        };

    private static bool IsSubHeader(string line) => SubHeaders.Contains(line.Trim());

    private ExtractedMemberDto? TryParseScheduleRow(string line)
    {
        var sectionMatch = SteelSectionPattern.Match(line);
        if (!sectionMatch.Success) sectionMatch = HollowSectionPattern.Match(line);
        if (!sectionMatch.Success) return null;

        var sectionRaw = sectionMatch.Value.Trim();
        var mark = ExtractPdfMark(line, sectionMatch) ?? NormalizeSection(sectionRaw);
        var memberType = DetectMemberType(mark, sectionRaw);

        return new ExtractedMemberDto(
            mark, NormalizeSection(sectionRaw), memberType,
            0, 0, 0,
            $"Schedule: {TruncateLine(line)}",
            0.90
        );
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

            var reidMatch = ReidBarPattern.Match(line);
            if (reidMatch.Success && !IsNoisePatternLine(line, reidMatch))
            {
                var mark = ExtractPdfMark(line, reidMatch) ?? reidMatch.Groups[1].Value.ToUpperInvariant();
                results.Add(new ExtractedMemberDto(
                    mark, reidMatch.Groups[1].Value.ToUpperInvariant(), "Other",
                    0, 0, 0, $"Pattern: {TruncateLine(line)}", 0.70));
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
        // COLUMNS list: "SC2 - 360 UB 45" / "C1 - 610 UB 113"
        var leading = Regex.Match(line.Trim(),
            @"^([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:]\s*",
            RegexOptions.IgnoreCase);
        if (leading.Success) return leading.Groups[1].Value.ToUpperInvariant();

        var tableMark = TableRowMarkPattern.Match(line);
        if (tableMark.Success) return tableMark.Groups[1].Value.ToUpperInvariant();

        var schedMark = PdfScheduleMarkPattern.Match(line);
        if (schedMark.Success) return schedMark.Groups[1].Value.ToUpperInvariant();

        var labelMark = Regex.Match(line,
            @"(?:Schedule|Pattern|SCHEDULE|PATTERN)\s*:\s*([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—]",
            RegexOptions.IgnoreCase);
        if (labelMark.Success) return labelMark.Groups[1].Value.ToUpperInvariant();

        if (sectionMatch.Index > 0)
        {
            var before = line[..sectionMatch.Index].Trim();
            var dashMark = Regex.Match(before,
                @"([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—]?\s*$",
                RegexOptions.IgnoreCase);
            if (dashMark.Success) return dashMark.Groups[1].Value.ToUpperInvariant();

            var tokens = before.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length > 0)
            {
                var last = tokens[^1].Trim().TrimEnd('-', '–', '—');
                if (Regex.IsMatch(last, @"^[A-Z]{1,4}\d{0,3}[A-Z]?$", RegexOptions.IgnoreCase))
                    return last.ToUpperInvariant();
            }
        }

        // B1, C7 only — not M1 auto-fallback (exclude M to avoid false matches)
        var memberMark = Regex.Match(line, @"(?<![A-Z])([BCPRGFHK]\d{1,2})\b");
        if (memberMark.Success && memberMark.Index < sectionMatch.Index)
            return memberMark.Groups[1].Value.ToUpperInvariant();

        return null;
    }

    private static bool IsNoisePatternLine(string line, Match sectionMatch)
    {
        var upper = line.ToUpperInvariant();
        if (upper.Contains("REINFORCEMENT")) return true;
        if (upper.Contains("PROVIDE")) return true;
        if (upper.Contains("WELD AT") || upper.Contains("WELD ON")) return true;
        if (upper.Contains("GENERAL NOTE") || upper.StartsWith("NOTE ")) return true;
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
