namespace ConstructionEstimation.API.Services.Licensing;

public sealed class LicenseStartupValidationService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<LicenseStartupValidationService> _logger;

    public LicenseStartupValidationService(
        IServiceScopeFactory scopeFactory,
        ILogger<LicenseStartupValidationService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<ILicenseService>();
            await service.EnsureServerConfigurationAsync(stoppingToken);
            var status = await service.GetConfigurationStatusAsync(stoppingToken);
            if (!status.IsConfigured)
            {
                _logger.LogWarning(
                    "License configuration is missing; System Settings is required before login");
                return;
            }

            var validation = await service.ValidateCurrentAsync(
                forceRefresh: true,
                source: "startup",
                stoppingToken);
            _logger.Log(
                validation.IsValid ? LogLevel.Information : LogLevel.Warning,
                "Startup license validation completed with status {LicenseStatus}",
                validation.Status);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Startup license validation failed");
        }
    }
}
