using ConstructionEstimation.API.Services.Licensing;
using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ConstructionEstimation.API.Controllers;

[ApiController]
[Route("api/license")]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class LicenseController : ControllerBase
{
    private readonly ILicenseService _licenseService;

    public LicenseController(ILicenseService licenseService)
    {
        _licenseService = licenseService;
    }

    [AllowAnonymous]
    [HttpGet("status")]
    public async Task<ActionResult<ApiResponse<LicenseConfigurationStatusDto>>> GetStatus(
        CancellationToken cancellationToken)
    {
        var status = await _licenseService.GetConfigurationStatusAsync(cancellationToken);
        return Ok(ApiResponse<LicenseConfigurationStatusDto>.Ok(status));
    }

    [AllowAnonymous]
    [HttpGet("startup")]
    public async Task<ActionResult<ApiResponse<LicenseValidationResponseDto>>> ValidateStartup(
        CancellationToken cancellationToken)
    {
        var result = await _licenseService.ValidateCurrentAsync(
            forceRefresh: false,
            source: "frontend-startup",
            cancellationToken);
        var data = new LicenseValidationResponseDto
        {
            IsValid = result.IsValid,
            Status = result.Status.ToString(),
            Code = result.Code,
            Message = result.Message,
            ExpiresAt = result.ExpiresAt
        };
        return Ok(ApiResponse<LicenseValidationResponseDto>.Ok(data, result.Message));
    }

    [AllowAnonymous]
    [HttpPost("configuration")]
    public async Task<ActionResult<ApiResponse<LicenseValidationResponseDto>>> SaveConfiguration(
        [FromBody] LicenseConfigurationRequest request,
        CancellationToken cancellationToken)
    {
        var result = await _licenseService.ValidateAndSaveAsync(request, cancellationToken);
        if (!result.IsValid)
        {
            var response = ApiResponse<LicenseValidationResponseDto>.Fail(
                result.Message,
                result.Code);
            return result.Status switch
            {
                LicenseValidationStatus.ApiUnreachable =>
                    StatusCode(StatusCodes.Status503ServiceUnavailable, response),
                LicenseValidationStatus.InvalidResponse =>
                    StatusCode(StatusCodes.Status502BadGateway, response),
                _ => BadRequest(response)
            };
        }

        var data = new LicenseValidationResponseDto
        {
            IsValid = true,
            Status = result.Status.ToString(),
            Code = result.Code,
            Message = result.Message,
            ExpiresAt = result.ExpiresAt
        };
        return Ok(ApiResponse<LicenseValidationResponseDto>.Ok(
            data,
            "License configuration saved successfully."));
    }

    [Authorize]
    [HttpGet("session")]
    public ActionResult<ApiResponse<object>> GetSessionStatus() =>
        Ok(ApiResponse<object>.Ok(
            new { isValid = true },
            "License session is valid."));
}
