using ConstructionEstimation.Core.DTOs;
using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using System.Security.Cryptography;

namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicenseService : ILicenseService
{
    private const string CacheKey = "licensing:current-validation";
    private static readonly SemaphoreSlim ValidationLock = new(1, 1);

    private readonly ILicenseRepository _repository;
    private readonly ILicenseApiClient _apiClient;
    private readonly IDataProtector _protector;
    private readonly IMemoryCache _cache;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly LicensingOptions _options;
    private readonly ILogger<LicenseService> _logger;

    public LicenseService(
        ILicenseRepository repository,
        ILicenseApiClient apiClient,
        IDataProtectionProvider dataProtectionProvider,
        IMemoryCache cache,
        IHttpContextAccessor httpContextAccessor,
        IOptions<LicensingOptions> options,
        ILogger<LicenseService> logger)
    {
        _repository = repository;
        _apiClient = apiClient;
        _protector = dataProtectionProvider.CreateProtector("BuildTakeoffPro.Licensing.v1");
        _cache = cache;
        _httpContextAccessor = httpContextAccessor;
        _options = options.Value;
        _logger = logger;
    }

    public async Task EnsureServerConfigurationAsync(
        CancellationToken cancellationToken = default)
    {
        await ValidationLock.WaitAsync(cancellationToken);
        try
        {
            var configuration = await _repository.GetActiveAsync(cancellationToken);
            if (configuration is null)
            {
                configuration = new LicenseConfiguration
                {
                    EncryptedLicenseKey = string.Empty,
                    ApiBaseUrl = _options.ApplicationApiUrl.Trim(),
                    ValidationEndpoint = _options.ValidationUrl.Trim(),
                    ApplicationIdentifier = _options.DefaultApplicationIdentifier.Trim(),
                    IsActive = true,
                    LastValidationStatus = LicenseValidationStatus.MissingConfiguration.ToString()
                };
                await _repository.SaveAsync(configuration, cancellationToken);
                _logger.LogInformation(
                    "Created server-managed license configuration without a license key");
                return;
            }

            var changed = false;
            var configuredApiUrl = _options.ApplicationApiUrl.Trim();
            if (IsValidBaseUrl(configuredApiUrl) &&
                !string.Equals(
                    configuration.ApiBaseUrl,
                    configuredApiUrl,
                    StringComparison.OrdinalIgnoreCase))
            {
                configuration.ApiBaseUrl = configuredApiUrl;
                changed = true;
            }

            if (!IsValidBaseUrl(configuration.ValidationEndpoint))
            {
                configuration.ValidationEndpoint = _options.ValidationUrl.Trim();
                changed = true;
            }

            if (string.IsNullOrWhiteSpace(configuration.ApplicationIdentifier))
            {
                configuration.ApplicationIdentifier = _options.DefaultApplicationIdentifier.Trim();
                changed = true;
            }

            if (changed)
            {
                await _repository.SaveAsync(configuration, cancellationToken);
                _logger.LogInformation("Updated missing server-managed license configuration values");
            }
        }
        finally
        {
            ValidationLock.Release();
        }
    }

    public async Task<LicenseConfigurationStatusDto> GetConfigurationStatusAsync(
        CancellationToken cancellationToken = default)
    {
        await EnsureServerConfigurationAsync(cancellationToken);
        var configuration = await _repository.GetActiveAsync(cancellationToken);
        if (configuration is null || string.IsNullOrWhiteSpace(configuration.EncryptedLicenseKey))
        {
            return new LicenseConfigurationStatusDto
            {
                IsConfigured = false,
                Status = LicenseValidationStatus.MissingConfiguration.ToString()
            };
        }

        string? maskedLicenseKey;
        var status = configuration.LastValidationStatus;
        try
        {
            maskedLicenseKey = MaskSecret(Unprotect(configuration.EncryptedLicenseKey));
        }
        catch (CryptographicException)
        {
            maskedLicenseKey = null;
            status = LicenseValidationStatus.InvalidConfiguration.ToString();
        }

        return new LicenseConfigurationStatusDto
        {
            IsConfigured = true,
            MaskedLicenseKey = maskedLicenseKey,
            Status = status,
            LastValidatedAt = configuration.LastValidatedAt,
            ExpiresAt = configuration.ExpiresAt
        };
    }

    public async Task<LicenseValidationResult> ValidateCurrentAsync(
        bool forceRefresh,
        string source,
        CancellationToken cancellationToken = default)
    {
        await EnsureServerConfigurationAsync(cancellationToken);
        if (!forceRefresh &&
            _cache.TryGetValue(CacheKey, out LicenseValidationResult? cached) &&
            cached is not null)
            return cached;

        await ValidationLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh &&
                _cache.TryGetValue(CacheKey, out cached) &&
                cached is not null)
                return cached;

            var configuration = await _repository.GetActiveAsync(cancellationToken);
            if (configuration is null || string.IsNullOrWhiteSpace(configuration.EncryptedLicenseKey))
            {
                var missing = CreateLocalResult(LicenseValidationStatus.MissingConfiguration);
                Cache(missing);
                _logger.LogWarning(
                    "License validation rejected from {ValidationSource}: configuration is missing",
                    source);
                return missing;
            }

            LicenseValidationResult result;
            try
            {
                result = await _apiClient.ValidateAsync(
                    ToApiRequest(configuration),
                    cancellationToken);
            }
            catch (CryptographicException exception)
            {
                _logger.LogError(
                    exception,
                    "Stored license configuration is not decryptable during {ValidationSource}",
                    source);
                result = CreateLocalResult(LicenseValidationStatus.InvalidConfiguration);
            }
            catch (Exception exception) when (
                exception is not OperationCanceledException ||
                !cancellationToken.IsCancellationRequested)
            {
                _logger.LogError(
                    exception,
                    "Unexpected license validation failure from {ValidationSource}",
                    source);
                result = CreateLocalResult(LicenseValidationStatus.ApiUnreachable);
            }

            configuration.LastValidationStatus = result.Status.ToString();
            configuration.LastValidatedAt = DateTime.UtcNow;
            if (result.ExpiresAt is not null)
                configuration.ExpiresAt = result.ExpiresAt;
            await _repository.SaveAsync(configuration, cancellationToken);

            Cache(result);
            if (result.IsValid)
                _logger.LogInformation(
                    "License validation succeeded from {ValidationSource}; cached until {CacheUntil}",
                    source,
                    result.CacheUntil);
            else
                _logger.LogWarning(
                    "License validation failed from {ValidationSource} with status {LicenseStatus}",
                    source,
                    result.Status);

            return result;
        }
        finally
        {
            ValidationLock.Release();
        }
    }

    public async Task<LicenseValidationResult> ValidateAndSaveAsync(
        LicenseConfigurationRequest request,
        CancellationToken cancellationToken = default)
    {
        await EnsureServerConfigurationAsync(cancellationToken);
        await ValidationLock.WaitAsync(cancellationToken);
        try
        {
            var existing = await _repository.GetActiveAsync(cancellationToken);
            var licenseKey = ResolveSecret(
                request.LicenseKey,
                existing?.EncryptedLicenseKey,
                required: true);
            var apiKey = ResolveSecret(
                submitted: null,
                existing?.EncryptedApiKey,
                required: false);
            var apiUrl = ResolveApplicationApiUrl(existing?.ApiBaseUrl);
            var validationUrl = FirstNotBlank(existing?.ValidationEndpoint, _options.ValidationUrl);

            if (string.IsNullOrWhiteSpace(licenseKey))
                return CreateLocalResult(
                    LicenseValidationStatus.MissingConfiguration,
                    "A license key is required.");
            if (!IsValidBaseUrl(apiUrl) || !IsValidBaseUrl(validationUrl))
                return CreateLocalResult(
                    LicenseValidationStatus.InvalidConfiguration,
                    "License server configuration is missing. Please contact your administrator.");

            var result = await _apiClient.ValidateAsync(
                new LicenseApiRequest(
                    licenseKey,
                    apiKey,
                    apiUrl,
                    validationUrl),
                cancellationToken);

            // A temporary provider/network failure must not force an installer
            // user to type the administrator-provided key again. Persist the
            // encrypted configuration so startup/manual validation can retry,
            // but keep the result non-valid so login and licensed APIs remain
            // blocked. Definitively invalid/expired/revoked/not-found keys are
            // still rejected without replacing the stored configuration.
            var canPersistForRetry = result.Status is
                LicenseValidationStatus.ApiUnreachable or
                LicenseValidationStatus.InvalidResponse;
            if (!result.IsValid && !canPersistForRetry)
            {
                _logger.LogWarning(
                    "License configuration was not saved because validation returned {LicenseStatus}",
                    result.Status);
                return result;
            }

            var configuration = existing ?? new LicenseConfiguration();
            configuration.EncryptedLicenseKey = _protector.Protect(licenseKey);
            configuration.EncryptedApiKey = string.IsNullOrWhiteSpace(apiKey)
                ? null
                : _protector.Protect(apiKey);
            configuration.ApiBaseUrl = apiUrl;
            configuration.ValidationEndpoint = validationUrl;
            configuration.ApplicationIdentifier = FirstNotBlank(
                existing?.ApplicationIdentifier,
                _options.DefaultApplicationIdentifier);
            configuration.IsActive = true;
            configuration.LastValidationStatus = result.Status.ToString();
            configuration.LastValidatedAt = DateTime.UtcNow;
            configuration.ExpiresAt = result.ExpiresAt;

            await _repository.SaveAsync(configuration, cancellationToken);
            Cache(result);
            if (result.IsValid)
            {
                _logger.LogInformation("License configuration saved after successful validation");
            }
            else
            {
                _logger.LogWarning(
                    "License configuration saved securely for retry after {LicenseStatus}",
                    result.Status);
            }
            return result;
        }
        catch (Exception exception) when (
            exception is not OperationCanceledException ||
            !cancellationToken.IsCancellationRequested)
        {
            _logger.LogError(exception, "Unable to validate and save license configuration");
            return CreateLocalResult(LicenseValidationStatus.ApiUnreachable);
        }
        finally
        {
            ValidationLock.Release();
        }
    }

    public void InvalidateCache()
    {
        _cache.Remove(CacheKey);
        _logger.LogInformation("License validation cache invalidated");
    }

    private LicenseApiRequest ToApiRequest(LicenseConfiguration configuration) =>
        new(
            Unprotect(configuration.EncryptedLicenseKey),
            string.IsNullOrWhiteSpace(configuration.EncryptedApiKey)
                ? null
                : Unprotect(configuration.EncryptedApiKey),
            configuration.ApiBaseUrl,
            configuration.ValidationEndpoint);

    private LicenseValidationResult CreateLocalResult(
        LicenseValidationStatus status,
        string? messageOverride = null)
    {
        var (code, message) = LicenseMessages.For(status);
        return new LicenseValidationResult
        {
            Status = status,
            Code = code,
            Message = messageOverride ?? message,
            CacheUntil = DateTime.UtcNow.AddMinutes(
                Math.Clamp(_options.FailureCacheMinutes, 1, 60))
        };
    }

    private string? ResolveSecret(string? submitted, string? encryptedExisting, bool required)
    {
        if (!string.IsNullOrWhiteSpace(submitted))
            return submitted.Trim();
        if (!string.IsNullOrWhiteSpace(encryptedExisting))
            return Unprotect(encryptedExisting);
        return required ? string.Empty : null;
    }

    private string Unprotect(string protectedValue)
    {
        try
        {
            return _protector.Unprotect(protectedValue);
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Stored license configuration could not be decrypted");
            throw;
        }
    }

    private void Cache(LicenseValidationResult result)
    {
        var expiration = result.CacheUntil ?? DateTime.UtcNow.AddMinutes(
            result.IsValid
                ? Math.Clamp(_options.CacheMinutes, 1, 1440)
                : Math.Clamp(_options.FailureCacheMinutes, 1, 60));
        if (expiration <= DateTime.UtcNow)
            expiration = DateTime.UtcNow.AddMinutes(1);

        _cache.Set(CacheKey, result, new DateTimeOffset(expiration));
    }

    private static string FirstNotBlank(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;

    private string ResolveApplicationApiUrl(string? storedUrl)
    {
        var configuredUrl = _options.ApplicationApiUrl.Trim();
        if (IsValidBaseUrl(configuredUrl))
            return configuredUrl;

        var requestUrl = GetCurrentRequestBaseUrl();
        var storedIsValid = IsValidBaseUrl(storedUrl ?? string.Empty);

        // Preserve a real server-managed URL, but replace the legacy localhost:5000
        // placeholder with the actual IIS address used for this configuration request.
        if (storedIsValid && !IsLoopbackUrl(storedUrl!))
            return storedUrl!.Trim();
        if (IsValidBaseUrl(requestUrl))
            return requestUrl;

        return storedIsValid ? storedUrl!.Trim() : string.Empty;
    }

    private string GetCurrentRequestBaseUrl()
    {
        var request = _httpContextAccessor.HttpContext?.Request;
        if (request is null ||
            string.IsNullOrWhiteSpace(request.Scheme) ||
            !request.Host.HasValue)
            return string.Empty;

        return $"{request.Scheme}://{request.Host}{request.PathBase}".TrimEnd('/');
    }

    private static bool IsLoopbackUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.IsLoopback ||
         uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase));

    private static bool IsValidBaseUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static string MaskSecret(string secret)
    {
        if (secret.Length <= 8)
            return new string('•', Math.Max(secret.Length, 4));

        return $"{secret[..4]}{new string('•', Math.Min(secret.Length - 8, 12))}{secret[^4..]}";
    }
}
