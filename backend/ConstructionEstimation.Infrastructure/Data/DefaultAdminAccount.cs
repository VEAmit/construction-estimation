using ConstructionEstimation.Core.Entities;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Data;

/// <summary>
/// Restores the built-in administrator only for a completely empty Users table.
/// This covers fresh/partially-created installer databases where EF's original
/// migration seed has already been marked as applied.
/// </summary>
public static class DefaultAdminAccount
{
    public const string Email = "admin@buildtakeoff.com";

    // BCrypt hash for the documented installer password. Keeping only the hash
    // in the application avoids storing the password itself in configuration.
    public const string PasswordHash =
        "$2a$11$yAsWoZ4a/pmZIu6lhZrxLORpVXrp.pR1K0FsFqvk03tHtsUQewUD6";

    // This hash shipped in earlier builds but does not validate Admin@123.
    // It is used only to identify and repair that exact built-in seed record.
    private const string LegacyInvalidPasswordHash =
        "$2a$11$rTzW3eSgkqkbVmMpGXqWZ.hKgMJJJsVzf2QJsqVTJyPpzX1X1fRYm";

    public static async Task<DefaultAdminSeedResult> EnsureAvailableAsync(
        AppDbContext db,
        CancellationToken cancellationToken = default)
    {
        // Repair only the exact legacy built-in account. A password changed by
        // a user has a different salted hash and is never modified here.
        var legacyAdmin = await db.Users
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(
                user => user.Email == Email
                    && !user.IsDeleted
                    && user.Role == "Admin"
                    && user.PasswordHash == LegacyInvalidPasswordHash,
                cancellationToken);

        if (legacyAdmin is not null)
        {
            legacyAdmin.PasswordHash = PasswordHash;
            await db.SaveChangesAsync(cancellationToken);
            return DefaultAdminSeedResult.LegacyPasswordRepaired;
        }

        // Ignore the soft-delete filter deliberately: this recovery must never
        // add an account when any other user record already exists.
        if (await db.Users.IgnoreQueryFilters().AnyAsync(cancellationToken))
            return DefaultAdminSeedResult.Unchanged;

        var now = DateTime.UtcNow;
        db.Users.Add(new User
        {
            FirstName = "Amit",
            LastName = "Kumar",
            Email = Email,
            PasswordHash = PasswordHash,
            Role = "Admin",
            CreatedAt = now,
            UpdatedAt = now,
            IsDeleted = false
        });

        await db.SaveChangesAsync(cancellationToken);
        return DefaultAdminSeedResult.Created;
    }
}

public enum DefaultAdminSeedResult
{
    Unchanged,
    Created,
    LegacyPasswordRepaired
}
