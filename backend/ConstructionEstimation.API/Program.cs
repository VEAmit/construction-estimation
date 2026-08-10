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
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Serilog;
using System.Text;

SyncfusionLicenseProvider.RegisterLicense("Ngo9BigBOggjHTQxAR8/V1NNaF5cXmBCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdmWXpedHZWQ2BeVEdwXUdWYUA=");

var builder = WebApplication.CreateBuilder(args);

// Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .CreateLogger();
builder.Host.UseSerilog();

// Infrastructure (EF Core + Repositories)
builder.Services.AddInfrastructure(builder.Configuration);

// ── Upload size limits ───────────────────────────────────────────────────
// A drawing PDF has to clear four independent ceilings, each rejecting with a
// different status, which is why raising only one of them looks like it did
// nothing:
//   1. IIS request filtering (web.config maxAllowedContentLength) -> 404.13
//   2. IIS in-process server                                      -> 413
//   3. Kestrel, when not hosted behind IIS                        -> 413
//   4. Multipart form binding                                     -> 400
//
// Number 2 was never configured and defaults to only ~28.6 MB, so a PDF that
// IIS itself accepted was still rejected with 413 by the in-process server.
// The action-level [RequestSizeLimit] does not raise that ceiling.
//
// Keep web.config's maxAllowedContentLength >= this value, or IIS rejects
// first with 404.13 and this setting never comes into play.
var maxUploadBytes = builder.Configuration.GetValue<long?>("Uploads:MaxBytes") ?? 209_715_200; // 200 MB

builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = maxUploadBytes;
});
builder.Services.Configure<KestrelServerOptions>(options =>
{
    options.Limits.MaxRequestBodySize = maxUploadBytes;
});
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = maxUploadBytes;
});

// App services
builder.Services.AddScoped<TokenService>();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ConstructionEstimation.API.Services.ExtractionService>();
builder.Services.Configure<LicensingOptions>(
    builder.Configuration.GetSection(LicensingOptions.SectionName));

// License keys are protected with ASP.NET Core Data Protection before they are
// stored in LicenseConfigurations.  The default key-ring location is not
// reliable for an IIS application pool (it can be temporary or tied to a
// different worker-process identity), which makes a valid stored license look
// like InvalidConfiguration after an app-pool recycle.  Keep the ring in the
// application data directory so it survives restarts and deployments that
// preserve the application's data folder.  A configured path can still be
// supplied by an administrator when the site runs from a read-only folder.
var dataProtectionKeysPath = builder.Configuration["DataProtection:KeysPath"];
if (string.IsNullOrWhiteSpace(dataProtectionKeysPath))
{
    dataProtectionKeysPath = Path.Combine(
        builder.Environment.ContentRootPath,
        "App_Data",
        "DataProtection-Keys");
}
else if (!Path.IsPathRooted(dataProtectionKeysPath))
{
    dataProtectionKeysPath = Path.Combine(
        builder.Environment.ContentRootPath,
        dataProtectionKeysPath);
}

Directory.CreateDirectory(dataProtectionKeysPath);
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
