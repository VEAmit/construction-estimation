using System.Collections.Concurrent;
using Syncfusion.EJ2.PdfViewer;

namespace ConstructionEstimation.API.Services;

/// <summary>
/// In-memory implementation of Syncfusion ICacheManager required by PdfRenderer v33+.
/// Registered as a singleton so rendered page data persists across requests.
/// </summary>
public sealed class PdfViewerCacheManager : ICacheManager
{
    private readonly ConcurrentDictionary<string, byte[]> _store = new();

    public void AddCache(string key, byte[] value)
    {
        _store[key] = value;
    }

    public byte[] GetCache(string key)
    {
        _store.TryGetValue(key, out var value);
        return value ?? Array.Empty<byte>();
    }

    public void DeleteCache(string key)
    {
        _store.TryRemove(key, out _);
    }
}
