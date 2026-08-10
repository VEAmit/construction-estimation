using ConstructionEstimation.API.Services;
using ConstructionEstimation.API.Middleware;
using ConstructionEstimation.API.Services.Licensing;
using Syncfusion.Licensing;
using ConstructionEstimation.Infrastructure;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.IIS;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Serilog;
using System.Text;

SyncfusionLicenseProvider.RegisterLicense("Ngo9BigBOggjHTQxAR8/V1NNaF5cXmBCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdmWXpedHZWQ2BeVEdwXUdWYUA=");

var builder = WebApplication.CreateBuilder(args);

// Keep the application-side upload limit aligned with DrawingsController and the
// IIS requestFiltering limit in web.config.  IIS can reject a multipart request
// before the controller runs, so configuring both layers makes large (35 MB+)
// construction PDFs behave the same in local hosting and IIS.
const long MaxUploadBytes = 100_000_000;
builder.Services.Configure<IISServerOptions>(options =>
    options.MaxRequestBodySize = MaxUploadBytes);
builder.Services.Configure<FormOptions>(options =>
    options.MultipartBodyLengthLimit = MaxUploadBytes);

// Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .CreateLogger();
builder.Host.UseSerilog();

// Infrastructure (EF Core + Repositories)
builder.Services.AddInfrastructure(builder.Configuration);

// App services
builder.Services.AddScoped<TokenService>();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ConstructionEstimation.API.Services.ExtractionService>();
builder.Services.Configure<LicensingOptions>(
    builder.Configuration.GetSection(LicensingOptions.SectionName));

// License keys are protected with ASP.NET Core Data Protection before they are
// stored in LicenseConfigurations.  Keep the key ring outside the repository
// and publish directory so a branch switch, clean build or IIS deployment does
// not make an already validated license unreadable.  Existing keys created by
// the earlier App_Data implementation are merged automatically on first start.
var dataProtectionKeysPath = ResolveDataProtectionKeysPath(
    builder.Configuration,
    builder.Environment.ContentRootPath);
var dataProtectionBuilder = builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeysPath))
    .SetApplicationName("BuildTakeoffPro");
if (OperatingSystem.IsWindows())
{
    // Keep the persisted key ring protected at rest on IIS/Windows.  The
    // application-pool identity that created it must be retained across
    // restarts so the stored license can be decrypted.
    dataProtectionBuilder.ProtectKeysWithDpapi();
}
builder.Services.AddHttpClient("LicenseApi", client =>
{
    var timeoutSeconds = Math.Clamp(
        builder.Configuration.GetValue<int?>("Licensing:HttpTimeoutSeconds") ?? 15,
        2,
        120);
    client.Timeout = TimeSpan.FromSeconds(timeoutSeconds);
});
builder.Services.AddScoped<ILicenseApiClient, LicenseApiClient>();
builder.Services.AddScoped<ILicenseService, LicenseService>();
builder.Services.AddHostedService<LicenseStartupValidationService>();

// JWT Authentication
var jwtKey = builder.Configuration["Jwt:Key"]!;
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ValidateIssuer = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidateAudience = true,
            ValidAudience = builder.Configuration["Jwt:Audience"],
            ValidateLifetime = true,
            ClockSkew = TimeSpan.Zero
        };
    });

builder.Services.AddAuthorization();
builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
    });

// CORS — allow React dev server
builder.Services.AddCors(options =>
{
    options.AddPolicy("ReactApp", policy =>
        policy.WithOrigins("http://localhost:5173", "http://localhost:5174", "http://localhost:3000")
              .AllowAnyMethod()
              .AllowAnyHeader()
              .AllowCredentials()
    );
});

// Swagger / OpenAPI
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "BuildTakeoff Pro API",
        Version = "1.0.3",
        Description = "Construction Estimation & Digital Takeoff API"
    });
    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        In = ParameterLocation.Header,
        Description = "Enter 'Bearer {token}'",
        Name = "Authorization",
        Type = SecuritySchemeType.ApiKey,
        Scheme = "Bearer"
    });
    c.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } },
            Array.Empty<string>()
        }
    });
});

var app = builder.Build();

// Apply EF migrations and seed on startup
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    try
    {
        db.Database.Migrate();
        Log.Information("Database migrated successfully");
    }
    catch (Exception ex)
    {
        Log.Warning(ex, "Database migration failed — will attempt EnsureCreated");
        db.Database.EnsureCreated();
    }
}

app.UseSerilogRequestLogging();

var enableSwagger = app.Configuration.GetValue("EnableSwagger", app.Environment.IsDevelopment());
if (enableSwagger)
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "BuildTakeoff Pro API v1.0.3"));
}

app.UseRouting();
app.UseCors("ReactApp");
app.UseAuthentication();
app.UseMiddleware<LicenseMiddleware>();
app.UseAuthorization();
app.MapControllers();

// Serve uploaded files
app.UseStaticFiles();

// Port is not hardcoded here — it comes from:
//   IIS site binding (e.g. 202, 203), ASPNETCORE_URLS env var, or launchSettings.json
Log.Information("BuildTakeoff Pro API starting");
app.Run();

static string ResolveDataProtectionKeysPath(
    IConfiguration configuration,
    string contentRootPath)
{
    var previousDeploymentPath = Path.Combine(
        contentRootPath,
        "App_Data",
        "DataProtection-Keys");
    var configuredPath = configuration["DataProtection:KeysPath"]?.Trim();

    if (!string.IsNullOrWhiteSpace(configuredPath))
    {
        var resolvedConfiguredPath = Path.IsPathRooted(configuredPath)
            ? configuredPath
            : Path.Combine(contentRootPath, configuredPath);
        Directory.CreateDirectory(resolvedConfiguredPath);
        MergeDataProtectionKeys(previousDeploymentPath, resolvedConfiguredPath);
        return resolvedConfiguredPath;
    }

    var localApplicationData = Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData);
    if (!string.IsNullOrWhiteSpace(localApplicationData))
    {
        var stableUserPath = Path.Combine(
            localApplicationData,
            "ASP.NET",
            "DataProtection-Keys");
        try
        {
            Directory.CreateDirectory(stableUserPath);
            MergeDataProtectionKeys(previousDeploymentPath, stableUserPath);
            return stableUserPath;
        }
        catch (UnauthorizedAccessException)
        {
            // Some IIS identities do not have a loaded/writable user profile.
            // Fall back to the deployment-local ring instead of failing startup.
        }
        catch (IOException)
        {
            // Treat an unavailable profile path the same as a missing profile.
        }
    }

    Directory.CreateDirectory(previousDeploymentPath);
    return previousDeploymentPath;
}

static void MergeDataProtectionKeys(string sourcePath, string destinationPath)
{
    if (!Directory.Exists(sourcePath) ||
        string.Equals(
            Path.GetFullPath(sourcePath).TrimEnd(Path.DirectorySeparatorChar),
            Path.GetFullPath(destinationPath).TrimEnd(Path.DirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase))
        return;

    foreach (var sourceFile in Directory.EnumerateFiles(sourcePath, "key-*.xml"))
    {
        var destinationFile = Path.Combine(destinationPath, Path.GetFileName(sourceFile));
        if (!File.Exists(destinationFile))
            File.Copy(sourceFile, destinationFile);
    }
}
