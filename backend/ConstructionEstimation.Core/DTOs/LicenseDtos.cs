namespace ConstructionEstimation.Core.DTOs;

public enum LicenseValidationStatus
{
    Valid,
    Expired,
    Invalid,
    NotFound,
    Revoked,
    MissingConfiguration,
    InvalidConfiguration,
    ApiUnreachable,
    InvalidResponse
}

public static class LicenseErrorCodes
{
    public const string Valid = "LICENSE_VALID";
    public const string Expired = "LICENSE_EXPIRED";
    public const string Invalid = "LICENSE_INVALID";
    public const string NotFound = "LICENSE_NOT_FOUND";
    public const string Revoked = "LICENSE_REVOKED";
    public const string MissingConfiguration = "LICENSE_MISSING";
    public const string InvalidConfiguration = "LICENSE_CONFIGURATION_INVALID";
    public const string ApiUnreachable = "LICENSE_API_UNREACHABLE";
    public const string InvalidResponse = "LICENSE_API_INVALID_RESPONSE";
}

public sealed class LicenseConfigurationRequest
{
    public string? LicenseKey { get; set; }
}

public sealed class LicenseConfigurationStatusDto
{
    public bool IsConfigured { get; init; }
    public string? MaskedLicenseKey { get; init; }
    public string Status { get; init; } = "MissingConfiguration";
    public DateTime? LastValidatedAt { get; init; }
    public DateTime? ExpiresAt { get; init; }
}

public sealed class LicenseValidationResult
{
    public LicenseValidationStatus Status { get; init; }
    public string Code { get; init; } = LicenseErrorCodes.Invalid;
    public string Message { get; init; } = string.Empty;
    public DateTime? ExpiresAt { get; init; }
    public DateTime? CacheUntil { get; init; }
    public bool IsValid => Status == LicenseValidationStatus.Valid;
}

public sealed class LicenseValidationResponseDto
{
    public bool IsValid { get; init; }
    public string Status { get; init; } = string.Empty;
    public string Code { get; init; } = string.Empty;
    public string Message { get; init; } = string.Empty;
    public DateTime? ExpiresAt { get; init; }
}
