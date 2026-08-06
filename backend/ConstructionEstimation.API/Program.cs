using ConstructionEstimation.API.Services;
using ConstructionEstimation.API.Middleware;
using ConstructionEstimation.API.Services.Licensing;
using Syncfusion.Licensing;
using ConstructionEstimation.Infrastructure;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Serilog;
using System.Text;

SyncfusionLicenseProvider.RegisterLicense("Ngo9BigBOggjHTQxAR8/V1NNaF5cXmBCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdmWXpedHZWQ2BeVEdwXUdWYUA=");

// A Windows Service starts with its working directory set to %WINDIR%\System32,
// so the default content root would make CreateBuilder look for appsettings.json
// (and later wwwroot and tessdata) in System32 and silently find nothing - no
// connection string, no Serilog sinks, and a crash before the port is bound.
// The content root therefore has to be set here, when the builder is created:
// calling UseWindowsService() afterwards is too late, because configuration has
// already been read by then.
var isWindowsService = WindowsServiceHelpers.IsWindowsService();

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = isWindowsService ? AppContext.BaseDirectory : null
});

// Run as a Windows Service when started by the SCM (installer deployment).
// No-op when launched normally, so `dotnet run` and IIS are unaffected.
builder.Host.UseWindowsService();

// Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .CreateLogger();
builder.Host.UseSerilog();

// Writable data locations. Falls back to ContentRootPath when
// Storage:DataPath is unset, preserving development behaviour.
var appPaths = new AppPaths(builder.Environment, builder.Configuration);
appPaths.EnsureCreated();
builder.Services.AddSingleton(appPaths);

// Infrastructure (EF Core + Repositories)
builder.Services.AddInfrastructure(builder.Configuration);

// App services
builder.Services.AddScoped<TokenService>();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ConstructionEstimation.API.Services.ExtractionService>();
builder.Services.Configure<LicensingOptions>(
    builder.Configuration.GetSection(LicensingOptions.SectionName));
// DataProtection keys decrypt the stored licence key. Moving the key ring makes
// an already-stored licence undecryptable, so the explicit location is applied
// ONLY to installer-provisioned deployments (Storage:DataPath set), which are
// new and have no licence yet. Development and the existing IIS deployment keep
// the default location and their working licence.
var dataProtection = builder.Services.AddDataProtection()
    .SetApplicationName("BuildTakeoffPro");

if (appPaths.IsDataPathConfigured)
{
    // A Windows Service has no reliable user profile, so the default
    // profile-based key location cannot be used there.
    dataProtection.PersistKeysToFileSystem(new DirectoryInfo(appPaths.KeysPath));
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

// A Windows Service that fails during startup dies silently: the process exits,
// the file log may not even be configured yet, and the only visible symptom is a
// refused connection in the browser. The Event Log always works, so record the
// reason there before giving up.
void LogStartupFailure(Exception failure, string stage)
{
    Log.Fatal(failure, "BuildTakeoff Pro failed during {Stage}", stage);

    if (OperatingSystem.IsWindows())
    {
        try
        {
            const string source = "BuildTakeoffPro";
            if (!System.Diagnostics.EventLog.SourceExists(source))
                System.Diagnostics.EventLog.CreateEventSource(source, "Application");

            System.Diagnostics.EventLog.WriteEntry(
                source,
                $"BuildTakeoff Pro failed during {stage}.{Environment.NewLine}{Environment.NewLine}{failure}",
                System.Diagnostics.EventLogEntryType.Error);
        }
        catch
        {
            // Event Log unavailable (no permission to create the source, etc.).
            // Nothing further can be done to report this.
        }
    }

    Log.CloseAndFlush();
}

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
        try
        {
            db.Database.EnsureCreated();
        }
        catch (Exception fatal)
        {
            // Almost always an unreachable or misconfigured SQL Server.
            LogStartupFailure(fatal, "database initialisation");
            throw;
        }
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

// Serve the React bundle from wwwroot. UseDefaultFiles rewrites "/" to
// "/index.html" — without it the root returns 404 under Kestrel (IIS happened
// to mask this with its own default-document module).
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseCors("ReactApp");
app.UseAuthentication();
app.UseMiddleware<LicenseMiddleware>();
app.UseAuthorization();
app.MapControllers();

// Client-side routes (/drawings, /projects, ...) have no server endpoint, so a
// refresh or deep link would 404. Hand anything unmatched to the SPA. Declared
// after MapControllers so real API routes always win.
app.MapFallback(async context =>
{
    // An unmatched /api path must stay a genuine 404. Serving index.html here
    // would hand API callers HTML with a 200, hiding real routing mistakes and
    // breaking client-side error handling.
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    var indexPath = Path.Combine(app.Environment.WebRootPath ?? string.Empty, "index.html");
    if (!File.Exists(indexPath))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    context.Response.ContentType = "text/html";
    await context.Response.SendFileAsync(indexPath);
});

// Port is not hardcoded here — it comes from:
//   IIS site binding (e.g. 202, 203), ASPNETCORE_URLS env var, or launchSettings.json
try
{
    Log.Information("BuildTakeoff Pro API starting");
    app.Run();
}
catch (Exception ex)
{
    // Typically a port already in use, or the Kestrel endpoint being unbindable.
    LogStartupFailure(ex, "startup");
    throw;
}
