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
    public DbSet<LicenseConfiguration> LicenseConfigurations => Set<LicenseConfiguration>();
    public DbSet<MeasurementSection> MeasurementSections => Set<MeasurementSection>();
    public DbSet<MeasurementSectionPlacement> MeasurementSectionPlacements => Set<MeasurementSectionPlacement>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Global soft-delete filter
        modelBuilder.Entity<User>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<Project>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<Drawing>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<TakeoffItem>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<MemberScheduleItem>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<LicenseConfiguration>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<MeasurementSection>().HasQueryFilter(e => !e.IsDeleted);
        modelBuilder.Entity<MeasurementSectionPlacement>().HasQueryFilter(e => !e.IsDeleted);

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
            Email = DefaultAdminAccount.Email,
            PasswordHash = DefaultAdminAccount.PasswordHash,
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
            // A mark can legitimately refer to different sections in one
            // project. Only an exact project + mark + section is a duplicate.
            entity.HasIndex(e => new { e.ProjectId, e.Mark, e.MemberSize })
                  .IsUnique()
                  .HasFilter("[IsDeleted] = 0 AND [Mark] <> N''");
            entity.HasOne(m => m.Project)
                  .WithMany(p => p.MemberScheduleItems)
                  .HasForeignKey(m => m.ProjectId)
                  .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(m => m.Drawing)
                  .WithMany(d => d.MemberScheduleItems)
                  .HasForeignKey(m => m.DrawingId)
                  .OnDelete(DeleteBehavior.NoAction);
        });

        modelBuilder.Entity<LicenseConfiguration>(entity =>
        {
            entity.Property(e => e.EncryptedLicenseKey).IsRequired();
            entity.Property(e => e.ApiBaseUrl).HasMaxLength(500);
            entity.Property(e => e.ValidationEndpoint).HasMaxLength(500);
            entity.Property(e => e.ApplicationIdentifier).HasMaxLength(150);
            entity.Property(e => e.MachineIdentifier).HasMaxLength(256);
            entity.Property(e => e.CustomerName).HasMaxLength(200);
            entity.Property(e => e.CompanyName).HasMaxLength(200);
            entity.Property(e => e.LastValidationStatus).HasMaxLength(50);
            entity.HasIndex(e => e.IsActive);
        });

        modelBuilder.Entity<MeasurementSection>(entity =>
        {
            entity.Property(e => e.Name).HasMaxLength(200).IsRequired();
            entity.Property(e => e.Color).HasMaxLength(7).IsRequired();
            entity.Property(e => e.TemplateJson).IsRequired();
            entity.HasIndex(e => new { e.ProjectId, e.Name })
                  .IsUnique()
                  .HasFilter("[IsDeleted] = 0");
            entity.HasOne(e => e.Project)
                  .WithMany(project => project.MeasurementSections)
                  .HasForeignKey(e => e.ProjectId)
                  .OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(e => e.Placements)
                  .WithOne(placement => placement.MeasurementSection)
                  .HasForeignKey(placement => placement.MeasurementSectionId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<MeasurementSectionPlacement>(entity =>
        {
            entity.HasIndex(e => new { e.MeasurementSectionId, e.DrawingId, e.PageNumber });
            entity.HasOne(e => e.Drawing)
                  .WithMany()
                  .HasForeignKey(e => e.DrawingId)
                  .OnDelete(DeleteBehavior.NoAction);
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
