using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using ConstructionEstimation.Infrastructure.Repositories;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace ConstructionEstimation.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddDbContext<AppDbContext>(options =>
            options.UseSqlServer(
                configuration.GetConnectionString("DefaultConnection"),
                b => b.MigrationsAssembly("ConstructionEstimation.Infrastructure")
            )
        );

        services.AddScoped<IProjectRepository, ProjectRepository>();
        services.AddScoped<IDrawingRepository, DrawingRepository>();
        services.AddScoped<ITakeoffItemRepository, TakeoffItemRepository>();
        services.AddScoped<IMemberScheduleRepository, MemberScheduleRepository>();
        services.AddScoped<ILicenseRepository, LicenseRepository>();
        services.AddScoped<IMeasurementSectionRepository, MeasurementSectionRepository>();

        return services;
    }
}
