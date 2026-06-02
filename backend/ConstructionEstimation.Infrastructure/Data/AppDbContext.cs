using ConstructionEstimation.Core.Entities;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<User> Users => Set<User>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Drawing> Drawings => Set<Drawing>();
    public DbSet<TakeoffItem> TakeoffItems => Set<TakeoffItem>();
    public DbSet<MemberScheduleItem> MemberScheduleItems => Set<MemberScheduleItem>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Global soft-delete filter
        modelBuilder.Entity<User>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<Project>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<Drawing>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<TakeoffItem>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<MemberScheduleItem>().HasQueryFilter(e => !e.IsDeleted);

        modelBuilder.Entity<User>(entity =>
        {
            entity.HasIndex(e => e.Email).IsUnique();
            entity.Property(e => e.Email).HasMaxLength(256);
            entity.Property(e => e.FirstName).HasMaxLength(100);
            entity.Property(e => e.LastName).HasMaxLength(100);
        });

        modelBuilder.Entity<Project>(entity =>
        {
            entity.Property(e => e.Name).HasMaxLength(200);
            entity.Property(e => e.ProjectNumber).HasMaxLength(50);
            entity.Property(e => e.ClientName).HasMaxLength(200);
            entity.Property(e => e.Status).HasConversion<string>();
            entity.HasOne(p => p.User)
                  .WithMany(u => u.Projects)
                  .HasForeignKey(p => p.UserId)
                  .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Drawing>(entity =>
        {
            entity.Property(e => e.Name).HasMaxLength(300);
            entity.Property(e => e.FileName).HasMaxLength(300);
            entity.HasOne(d => d.Project)
                  .WithMany(p => p.Drawings)
                  .HasForeignKey(d => d.ProjectId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<TakeoffItem>(entity =>
        {
            entity.Property(e => e.Mark).HasMaxLength(50);
            entity.Property(e => e.Description).HasMaxLength(500);
            entity.Property(e => e.Material).HasMaxLength(100);
            entity.Property(e => e.ItemType).HasConversion<string>();
            entity.Property(e => e.Unit).HasConversion<string>();
            entity.HasOne(t => t.Drawing)
                  .WithMany(d => d.TakeoffItems)
                  .HasForeignKey(t => t.DrawingId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        // Seed default admin user (password: Admin@123)
        modelBuilder.Entity<User>().HasData(new User
        {
            Id = 1,
            FirstName = "Amit",
            LastName = "Kumar",
            Email = "admin@buildtakeoff.com",
            PasswordHash = "$2a$11$rTzW3eSgkqkbVmMpGXqWZ.hKgMJJJsVzf2QJsqVTJyPpzX1X1fRYm",
            Role = "Admin",
            CreatedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)
        });

        modelBuilder.Entity<MemberScheduleItem>(entity =>
        {
            entity.Property(e => e.Mark).HasMaxLength(50);
            entity.Property(e => e.MemberSize).HasMaxLength(100);
            entity.Property(e => e.MemberType).HasMaxLength(100);
            entity.Property(e => e.Description).HasMaxLength(500);
            entity.HasOne(m => m.Drawing)
                  .WithMany(d => d.MemberScheduleItems)
                  .HasForeignKey(m => m.DrawingId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        // Seed a default project
        modelBuilder.Entity<Project>().HasData(new Project
        {
            Id = 1,
            Name = "Steel Frame Building - Block A",
            ProjectNumber = "PRJ-001",
            Description = "Structural steel estimation for main building block",
            ClientName = "ABC Construction Ltd",
            Location = "Melbourne, VIC",
            Status = ProjectStatus.Active,
            UserId = 1,
            CreatedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)
        });
    }

    public override Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
    {
        foreach (var entry in ChangeTracker.Entries<Core.Entities.BaseEntity>())
        {
            if (entry.State == EntityState.Modified)
                entry.Entity.UpdatedAt = DateTime.UtcNow;
        }
        return base.SaveChangesAsync(cancellationToken);
    }
}
