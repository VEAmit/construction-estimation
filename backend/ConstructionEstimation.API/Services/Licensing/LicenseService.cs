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
    private readonly ILicenseMachineIdentifierProvider _machineIdentifierProvider;
    private readonly IDataProtector _protector;
    private readonly IMemoryCache _cache;
    private readonly LicensingOptions _options;
    private readonly ILogger<LicenseService> _logger;

    public LicenseService(
        ILicenseRepository repository,
        ILicenseApiClient apiClient,
        ILicenseMachineIdentifierProvider machineIdentifierProvider,
        IDataProtectionProvider dataProtectionProvider,
        IMemoryCache cache,
        IOptions<LicensingOptions> options,
        ILogger<LicenseService> logger)
    {
        _repository = repository;
        _apiClient = apiClient;
        _machineIdentifierProvider = machineIdentifierProvider;
        _protector = dataProtectionProvider.CreateProtector("BuildTakeoffPro.Licensing.v1");
        _cache = cache;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<LicenseConfigurationStatusDto> GetConfigurationStatusAsync(
        CancellationToken cancellationToken = default)
    {
        var configuration = await _repository.GetActiveAsync(cancellationToken);
        if (configuration is null || string.IsNullOrWhiteSpace(configuration.EncryptedLicenseKey))
        {
            return new LicenseConfigurationStatusDto
            {
                IsConfigured = false,
                ValidationEndpoint = _options.DefaultValidationEndpoint,
                ApplicationIdentifier = _options.DefaultApplicationIdentifier,
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
            HasApiKey = !string.IsNullOrWhiteSpace(configuration.EncryptedApiKey),
            ApiBaseUrl = configuration.ApiBaseUrl,
            ValidationEndpoint = configuration.ValidationEndpoint,
            ApplicationIdentifier = configuration.ApplicationIdentifier,
            MachineIdentifier = configuration.MachineIdentifier,
            CustomerName = configuration.CustomerName,
            CompanyName = configuration.CompanyName,
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
        await ValidationLock.WaitAsync(cancellationToken);
        try
        {
            var existing = await _repository.GetActiveAsync(cancellationToken);
            var licenseKey = ResolveSecret(
                request.LicenseKey,
                existing?.EncryptedLicenseKey,
                required: true);
            var apiKey = ResolveSecret(
                request.ApiKey,
                existing?.EncryptedApiKey,
                required: false);
            var apiBaseUrl = request.ApiBaseUrl?.Trim() ?? existing?.ApiBaseUrl ?? string.Empty;
            var validationEndpoint = FirstNotBlank(
                request.ValidationEndpoint,
                existing?.ValidationEndpoint,
                _options.DefaultValidationEndpoint);
            var applicationIdentifier = FirstNotBlank(
                request.ApplicationIdentifier,
                existing?.ApplicationIdentifier,
                _options.DefaultApplicationIdentifier);
            var machineIdentifier = FirstNotBlank(
                request.MachineIdentifier,
                existing?.MachineIdentifier,
                _machineIdentifierProvider.GetIdentifier());

            if (string.IsNullOrWhiteSpace(licenseKey))
                return CreateLocalResult(
                    LicenseValidationStatus.MissingConfiguration,
                    "A license key is required.");
            if (!IsValidBaseUrl(apiBaseUrl))
                return CreateLocalResult(
                    LicenseValidationStatus.InvalidConfiguration,
                    "Enter a valid HTTP or HTTPS API Base URL.");
            if (string.IsNullOrWhiteSpace(validationEndpoint))
                return CreateLocalResult(
                    LicenseValidationStatus.InvalidConfiguration,
                    "A validation endpoint is required.");
            if (string.IsNullOrWhiteSpace(applicationIdentifier))
                return CreateLocalResult(
                    LicenseValidationStatus.InvalidConfiguration,
                    "An application identifier is required.");

            var result = await _apiClient.ValidateAsync(
                new LicenseApiRequest(
                    licenseKey,
                    apiKey,
                    apiBaseUrl,
                    validationEndpoint,
                    applicationIdentifier,
                    machineIdentifier,
                    request.CustomerName?.Trim() ?? existing?.CustomerName,
                    request.CompanyName?.Trim() ?? existing?.CompanyName),
                cancellationToken);

            if (!result.IsValid)
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
            configuration.ApiBaseUrl = apiBaseUrl;
            configuration.ValidationEndpoint = validationEndpoint;
            configuration.ApplicationIdentifier = applicationIdentifier;
            configuration.MachineIdentifier = machineIdentifier;
            configuration.CustomerName = request.CustomerName?.Trim() ?? existing?.CustomerName;
            configuration.CompanyName = request.CompanyName?.Trim() ?? existing?.CompanyName;
            configuration.IsActive = true;
            configuration.LastValidationStatus = result.Status.ToString();
            configuration.LastValidatedAt = DateTime.UtcNow;
            configuration.ExpiresAt = result.ExpiresAt;

            await _repository.SaveAsync(configuration, cancellationToken);
            Cache(result);
            _logger.LogInformation("License configuration saved after successful validation");
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
            configuration.ValidationEndpoint,
            configuration.ApplicationIdentifier,
            FirstNotBlank(
                configuration.MachineIdentifier,
                _machineIdentifierProvider.GetIdentifier()),
            configuration.CustomerName,
            configuration.CompanyName);

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
