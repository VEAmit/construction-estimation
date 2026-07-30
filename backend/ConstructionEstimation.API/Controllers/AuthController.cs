using ConstructionEstimation.API.Services;
using ConstructionEstimation.API.Middleware;
using ConstructionEstimation.API.Services.Licensing;
using ConstructionEstimation.Core.Common;
using ConstructionEstimation.Core.DTOs;
using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.API.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly TokenService _tokenService;
    private readonly ILicenseService _licenseService;

    public AuthController(
        AppDbContext db,
        TokenService tokenService,
        ILicenseService licenseService)
    {
        _db = db;
        _tokenService = tokenService;
        _licenseService = licenseService;
    }

    [HttpPost("login")]
    public async Task<ActionResult<ApiResponse<AuthResponse>>> Login(
        [FromBody] LoginRequest request,
        CancellationToken cancellationToken)
    {
        var license = await _licenseService.ValidateCurrentAsync(
            forceRefresh: true,
            source: "login",
            cancellationToken);
        if (!license.IsValid)
            return StatusCode(
                StatusCodes.Status403Forbidden,
                ApiResponse<AuthResponse>.Fail(license.Message, license.Code));

        var user = await _db.Users.FirstOrDefaultAsync(
            u => u.Email == request.Email,
            cancellationToken);
        if (user == null || !BCrypt.Net.BCrypt.Verify(request.Password, user.PasswordHash))
            return Unauthorized(ApiResponse<AuthResponse>.Fail("Invalid email or password"));

        var (token, expiresAt) = _tokenService.GenerateToken(user);
        return Ok(ApiResponse<AuthResponse>.Ok(new AuthResponse(
            token, user.Email, $"{user.FirstName} {user.LastName}", user.Role, expiresAt
        )));
    }

    [HttpPost("register")]
    public async Task<ActionResult<ApiResponse<AuthResponse>>> Register(
        [FromBody] RegisterRequest request,
        CancellationToken cancellationToken)
    {
        var license = await _licenseService.ValidateCurrentAsync(
            forceRefresh: true,
            source: "registration",
            cancellationToken);
        if (!license.IsValid)
            return StatusCode(
                StatusCodes.Status403Forbidden,
                ApiResponse<AuthResponse>.Fail(license.Message, license.Code));

        if (await _db.Users.AnyAsync(u => u.Email == request.Email, cancellationToken))
            return BadRequest(ApiResponse<AuthResponse>.Fail("Email already registered"));

        var user = new User
        {
            FirstName = request.FirstName,
            LastName = request.LastName,
            Email = request.Email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
            Role = "Estimator"
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(cancellationToken);

        var (token, expiresAt) = _tokenService.GenerateToken(user);
        return Ok(ApiResponse<AuthResponse>.Ok(new AuthResponse(
            token, user.Email, $"{user.FirstName} {user.LastName}", user.Role, expiresAt
        )));
    }

    [Authorize]
    [SkipLicenseValidation]
    [HttpPost("logout")]
    public ActionResult<ApiResponse<object>> Logout()
    {
        _licenseService.InvalidateCache();
        return Ok(ApiResponse<object>.Ok(new { }, "Logged out successfully."));
    }
}
