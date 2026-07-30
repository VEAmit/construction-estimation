using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using ConstructionEstimation.Core.DTOs;
using Microsoft.Extensions.Options;

namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicenseApiClient : ILicenseApiClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly LicensingOptions _options;
    private readonly ILogger<LicenseApiClient> _logger;

    public LicenseApiClient(
        IHttpClientFactory httpClientFactory,
        IOptions<LicensingOptions> options,
        ILogger<LicenseApiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<LicenseValidationResult> ValidateAsync(
        LicenseApiRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!TryBuildEndpoint(request.ValidationUrl, out var endpoint))
            return Result(LicenseValidationStatus.InvalidResponse);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = JsonContent.Create(new
            {
                apiUrl = request.ApiUrl,
                licenceKey = request.LicenseKey
            })
        };

        if (!string.IsNullOrWhiteSpace(request.ApiKey))
            httpRequest.Headers.TryAddWithoutValidation(_options.ApiKeyHeaderName, request.ApiKey);

        var stopwatch = Stopwatch.StartNew();
        try
        {
            var client = _httpClientFactory.CreateClient("LicenseApi");
            using var response = await client.SendAsync(
                httpRequest,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            stopwatch.Stop();

            var result = ParseResponse(response.StatusCode, response.IsSuccessStatusCode, body);
            _logger.LogInformation(
                "License provider responded with status {LicenseStatus} in {ElapsedMilliseconds} ms",
                result.Status,
                stopwatch.ElapsedMilliseconds);
            return result;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            stopwatch.Stop();
            _logger.LogWarning(
                "License provider timed out after {ElapsedMilliseconds} ms",
                stopwatch.ElapsedMilliseconds);
            return Result(LicenseValidationStatus.ApiUnreachable);
        }
        catch (HttpRequestException exception)
        {
            stopwatch.Stop();
            _logger.LogWarning(
                exception,
                "License provider was unreachable after {ElapsedMilliseconds} ms",
                stopwatch.ElapsedMilliseconds);
            return Result(LicenseValidationStatus.ApiUnreachable);
        }
        catch (JsonException exception)
        {
            stopwatch.Stop();
            _logger.LogWarning(
                exception,
                "License provider returned invalid JSON after {ElapsedMilliseconds} ms",
                stopwatch.ElapsedMilliseconds);
            return Result(LicenseValidationStatus.InvalidResponse);
        }
    }

    private LicenseValidationResult ParseResponse(
        HttpStatusCode statusCode,
        bool isSuccessStatusCode,
        string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return statusCode switch
            {
                HttpStatusCode.NotFound => Result(LicenseValidationStatus.NotFound),
                HttpStatusCode.Gone => Result(LicenseValidationStatus.Revoked),
                _ when (int)statusCode >= 500 => Result(LicenseValidationStatus.ApiUnreachable),
                _ => Result(LicenseValidationStatus.InvalidResponse)
            };
        }

        using var document = JsonDocument.Parse(body);
        var payload = SelectPayload(document.RootElement);
        var status = ReadString(payload, "status", "licenseStatus", "state", "code");
        var responseStatus =
            ReadString(payload, "responsestatus", "responseStatus", "message") ??
            ReadString(document.RootElement, "responsestatus", "responseStatus", "message");
        var responseCode =
            ReadInt(payload, "responseCode") ??
            ReadInt(document.RootElement, "responseCode");
        var expiresAt = ReadDate(payload, "expiresAt", "expirationDate", "expiryDate", "validUntil");
        var cacheMinutes = ReadInt(payload, "cacheMinutes", "refreshAfterMinutes", "validationIntervalMinutes");
        var valid = ReadBoolean(payload, "isValid", "valid", "licenseValid");

        if (isSuccessStatusCode && responseCode == 4)
            valid = true;
        else if (responseCode is not null)
        {
            status = responseStatus ?? status;
            valid = false;
        }

        if (valid is null && string.IsNullOrWhiteSpace(status))
            valid = ReadBoolean(document.RootElement, "success");

        var mappedStatus = MapStatus(status, valid, statusCode, isSuccessStatusCode, expiresAt);
        var result = Result(mappedStatus, expiresAt, cacheMinutes, responseStatus);

        if (result.IsValid && expiresAt is not null && expiresAt <= DateTime.UtcNow)
            return Result(LicenseValidationStatus.Expired, expiresAt, cacheMinutes, responseStatus);

        return result;
    }

    private static JsonElement SelectPayload(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
            return root;

        foreach (var name in new[] { "data", "license", "result" })
        {
            if (TryGetProperty(root, name, out var nested) && nested.ValueKind == JsonValueKind.Object)
                return nested;
        }

        return root;
    }

    private static LicenseValidationStatus MapStatus(
        string? providerStatus,
        bool? valid,
        HttpStatusCode statusCode,
        bool isSuccessStatusCode,
        DateTime? expiresAt)
    {
        var normalized = (providerStatus ?? string.Empty)
            .Replace("_", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .ToLowerInvariant();

        if (normalized.Contains("expir"))
            return LicenseValidationStatus.Expired;
        if (normalized.Contains("revok") || normalized.Contains("suspend") || normalized.Contains("disable"))
            return LicenseValidationStatus.Revoked;
        if (normalized.Contains("notfound") || normalized.Contains("missing"))
            return LicenseValidationStatus.NotFound;
        if (normalized is "valid" or "active" or "licensed" or "success" or "ok")
            return expiresAt is not null && expiresAt <= DateTime.UtcNow
                ? LicenseValidationStatus.Expired
                : LicenseValidationStatus.Valid;
        if (normalized.Contains("invalid") || normalized.Contains("unauthor"))
            return LicenseValidationStatus.Invalid;

        if (valid == true)
            return expiresAt is not null && expiresAt <= DateTime.UtcNow
                ? LicenseValidationStatus.Expired
                : LicenseValidationStatus.Valid;
        if (valid == false)
            return LicenseValidationStatus.Invalid;

        return statusCode switch
        {
            HttpStatusCode.NotFound => LicenseValidationStatus.NotFound,
            HttpStatusCode.Gone => LicenseValidationStatus.Revoked,
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => LicenseValidationStatus.Invalid,
            _ when (int)statusCode >= 500 => LicenseValidationStatus.ApiUnreachable,
            _ when !isSuccessStatusCode => LicenseValidationStatus.Invalid,
            _ => LicenseValidationStatus.InvalidResponse
        };
    }

    private LicenseValidationResult Result(
        LicenseValidationStatus status,
        DateTime? expiresAt = null,
        int? providerCacheMinutes = null,
        string? messageOverride = null)
    {
        var (code, message) = LicenseMessages.For(status);
        var configuredMinutes = status == LicenseValidationStatus.Valid
            ? Math.Clamp(_options.CacheMinutes, 1, 1440)
            : Math.Clamp(_options.FailureCacheMinutes, 1, 60);
        var cacheMinutes = providerCacheMinutes is > 0
            ? Math.Min(providerCacheMinutes.Value, configuredMinutes)
            : configuredMinutes;
        var cacheUntil = DateTime.UtcNow.AddMinutes(cacheMinutes);

        if (expiresAt is not null && expiresAt > DateTime.UtcNow && expiresAt < cacheUntil)
            cacheUntil = expiresAt.Value;

        return new LicenseValidationResult
        {
            Status = status,
            Code = code,
            Message = string.IsNullOrWhiteSpace(messageOverride) ? message : messageOverride.Trim(),
            ExpiresAt = expiresAt,
            CacheUntil = cacheUntil
        };
    }

    private static bool TryBuildEndpoint(string validationUrl, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(validationUrl, UriKind.Absolute, out var endpoint) ||
            (endpoint.Scheme != Uri.UriSchemeHttp && endpoint.Scheme != Uri.UriSchemeHttps))
            return false;

        uri = endpoint;
        return true;
    }

    private static bool TryGetProperty(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (property.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }
        }

        value = default;
        return false;
    }

    private static string? ReadString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (TryGetProperty(element, name, out var value) &&
                value.ValueKind == JsonValueKind.String)
                return value.GetString();
        }

        return null;
    }

    private static bool? ReadBoolean(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!TryGetProperty(element, name, out var value))
                continue;

            if (value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                return value.GetBoolean();
            if (value.ValueKind == JsonValueKind.String &&
                bool.TryParse(value.GetString(), out var parsed))
                return parsed;
        }

        return null;
    }

    private static DateTime? ReadDate(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!TryGetProperty(element, name, out var value))
                continue;

            if (value.ValueKind == JsonValueKind.String &&
                DateTime.TryParse(
                    value.GetString(),
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal |
                    System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var parsed))
                return parsed;
        }

        return null;
    }

    private static int? ReadInt(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!TryGetProperty(element, name, out var value))
                continue;

            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
                return number;
            if (value.ValueKind == JsonValueKind.String &&
                int.TryParse(value.GetString(), out number))
                return number;
        }

        return null;
    }
}
