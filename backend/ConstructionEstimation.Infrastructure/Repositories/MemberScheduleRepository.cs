using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using System.Globalization;
using System.Text;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class MemberScheduleRepository : BaseRepository<MemberScheduleItem>, IMemberScheduleRepository
{
    public MemberScheduleRepository(AppDbContext context) : base(context) { }

    private IQueryable<MemberScheduleItem> WithActiveSourceDrawing() =>
        _context.MemberScheduleItems.Where(item =>
            item.DrawingId == null ||
            _context.Drawings.Any(drawing => drawing.Id == item.DrawingId.Value));

    public async Task<IEnumerable<MemberScheduleItem>> GetByProjectIdAsync(int projectId)
    {
        // Older builds could soft-delete a drawing without soft-deleting the
        // schedule rows extracted from it. The Drawings query filter makes the
        // Any() check consider active drawings only, so those legacy orphaned
        // rows disappear immediately while project-created (DrawingId = null)
        // and other active drawings' rows remain available.
        return await WithActiveSourceDrawing()
            .Where(m => m.ProjectId == projectId)
            .OrderBy(m => m.Mark)
            .ToListAsync();
    }

    public async Task<int> ConsolidateExactDuplicatesAsync(int projectId)
    {
        var items = await WithActiveSourceDrawing()
            .Where(item => item.ProjectId == projectId)
            .OrderBy(item => item.Id)
            .ToListAsync();

        var removed = 0;
        foreach (var group in items.GroupBy(BuildIdentityKey, StringComparer.Ordinal))
        {
            var duplicates = group.ToList();
            if (duplicates.Count < 2) continue;

            // Keep the first project-owned row when possible; otherwise retain
            // the first extracted occurrence. Later drawings must not create a
            // second schedule entry for the same Mark + Section pair.
            var keeper = duplicates
                .OrderByDescending(item => item.DrawingId == null)
                .ThenBy(item => item.Id)
                .First();

            var sourceDrawingCount = duplicates
                .Where(item => item.DrawingId.HasValue)
                .Select(item => item.DrawingId!.Value)
                .Distinct()
                .Count();
            if (duplicates.Any(item => item.DrawingId == null) || sourceDrawingCount > 1)
                keeper.DrawingId = null;

            foreach (var duplicate in duplicates.Where(item => item.Id != keeper.Id))
            {
                duplicate.IsDeleted = true;
                duplicate.UpdatedAt = DateTime.UtcNow;
                removed++;
            }
        }

        if (removed > 0)
            await _context.SaveChangesAsync();

        return removed;
    }

    public async Task<MemberScheduleItem?> GetByProjectAndMarkAsync(int projectId, string mark)
    {
        var normalizedMark = mark.Trim().ToUpper();
        return await WithActiveSourceDrawing()
            .FirstOrDefaultAsync(m =>
                m.ProjectId == projectId &&
                m.Mark.Trim().ToUpper() == normalizedMark);
    }

    public async Task<MemberScheduleItem?> GetByProjectMarkAndSectionAsync(
        int projectId,
        string mark,
        string memberSize)
    {
        var markKey = NormalizeIdentityPart(mark);
        var sectionKey = NormalizeIdentityPart(memberSize);
        var candidates = await WithActiveSourceDrawing()
            .Where(item => item.ProjectId == projectId)
            .ToListAsync();

        return candidates.FirstOrDefault(item =>
            NormalizeIdentityPart(item.Mark) == markKey &&
            NormalizeIdentityPart(item.MemberSize) == sectionKey);
    }

    public async Task<IEnumerable<MemberScheduleItem>> GetByDrawingIdAsync(int drawingId)
    {
        var projectId = await _context.Drawings
            .Where(d => d.Id == drawingId)
            .Select(d => (int?)d.ProjectId)
            .FirstOrDefaultAsync();

        return projectId.HasValue
            ? await GetByProjectIdAsync(projectId.Value)
            : [];
    }

    public async Task<bool> DeleteByProjectIdAsync(int projectId)
    {
        var items = await _context.MemberScheduleItems
            .Where(m => m.ProjectId == projectId)
            .ToListAsync();

        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }

    public async Task<bool> DeleteByDrawingIdAsync(int drawingId)
    {
        var items = await _context.MemberScheduleItems
            .Where(item => item.DrawingId == drawingId)
            .ToListAsync();

        foreach (var item in items)
            item.IsDeleted = true;

        await _context.SaveChangesAsync();
        return true;
    }

    private static string BuildIdentityKey(MemberScheduleItem item) =>
        $"{NormalizeIdentityPart(item.Mark)}|{NormalizeIdentityPart(item.MemberSize)}";

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
