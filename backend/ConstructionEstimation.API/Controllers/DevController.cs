using ConstructionEstimation.Infrastructure.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.API.Controllers;

/// <summary>
/// Development-only controller for initial setup. Remove in production.
/// </summary>
[ApiController]
[Route("api/dev")]
public class DevController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IWebHostEnvironment _env;

    public DevController(AppDbContext db, IWebHostEnvironment env)
    {
        _db = db;
        _env = env;
    }

    [HttpPost("reset-admin")]
    public async Task<IActionResult> ResetAdmin([FromQuery] string newPassword = "Admin@123")
    {
        if (!_env.IsDevelopment())
            return Forbid();

        var admin = await _db.Users.FirstOrDefaultAsync(u => u.Email == "admin@buildtakeoff.com");
        if (admin == null)
            return NotFound("Admin user not found");

        admin.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword);
        admin.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return Ok($"Admin password reset to: {newPassword}");
    }
}
