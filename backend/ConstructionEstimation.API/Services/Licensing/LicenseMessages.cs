using ConstructionEstimation.Core.DTOs;

namespace ConstructionEstimation.API.Services.Licensing;

public static class LicenseMessages
{
    public static (string Code, string Message) For(LicenseValidationStatus status) =>
        status switch
        {
            LicenseValidationStatus.Valid =>
                (LicenseErrorCodes.Valid, "License validated successfully."),
            LicenseValidationStatus.Expired =>
                (LicenseErrorCodes.Expired, "Your license has expired. Please contact your administrator."),
            LicenseValidationStatus.NotFound =>
                (LicenseErrorCodes.NotFound, "The configured license was not found. Please contact your administrator."),
            LicenseValidationStatus.Revoked =>
                (LicenseErrorCodes.Revoked, "The configured license has been revoked. Please contact your administrator."),
            LicenseValidationStatus.MissingConfiguration =>
                (LicenseErrorCodes.MissingConfiguration, "License configuration is missing. Please open System Settings."),
            LicenseValidationStatus.InvalidConfiguration =>
                (LicenseErrorCodes.InvalidConfiguration, "The license configuration is incomplete or invalid."),
            LicenseValidationStatus.ApiUnreachable =>
                (LicenseErrorCodes.ApiUnreachable, "Unable to validate license. Please check your internet connection or contact your administrator."),
            LicenseValidationStatus.InvalidResponse =>
                (LicenseErrorCodes.InvalidResponse, "Unable to validate license because the license server returned an invalid response. Please contact your administrator."),
            _ =>
                (LicenseErrorCodes.Invalid, "The configured license is invalid. Please contact your administrator.")
        };
}
