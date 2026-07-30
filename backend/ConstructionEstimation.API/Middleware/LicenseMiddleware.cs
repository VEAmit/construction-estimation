using ConstructionEstimation.API.Services.Licensing;
using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using Microsoft.AspNetCore.Authorization;

namespace ConstructionEstimation.API.Middleware;

public sealed class LicenseMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<LicenseMiddleware> _logger;

    public LicenseMiddleware(RequestDelegate next, ILogger<LicenseMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, ILicenseService licenseService)
    {
        if (!context.Request.Path.StartsWithSegments("/api") ||
            context.User.Identity?.IsAuthenticated != true ||
            ShouldSkip(context))
        {
            await _next(context);
            return;
        }

        var validation = await licenseService.ValidateCurrentAsync(
            forceRefresh: false,
            source: "middleware",
            context.RequestAborted);
        if (validation.IsValid)
        {
            await _next(context);
            return;
        }

        _logger.LogWarning(
            "Protected request {RequestMethod} {RequestPath} rejected by license middleware with status {LicenseStatus}",
            context.Request.Method,
            context.Request.Path,
            validation.Status);

        var message = validation.Status is
            LicenseValidationStatus.ApiUnreachable or
            LicenseValidationStatus.InvalidResponse
                ? validation.Message
                : "Your license is no longer valid.";

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(
            ApiResponse<object>.Fail(message, validation.Code, requiresLogout: true),
            context.RequestAborted);
    }

    private static bool ShouldSkip(HttpContext context)
    {
        var endpoint = context.GetEndpoint();
        return endpoint?.Metadata.GetMetadata<IAllowAnonymous>() is not null ||
               endpoint?.Metadata.GetMetadata<SkipLicenseValidationAttribute>() is not null;
    }
}
