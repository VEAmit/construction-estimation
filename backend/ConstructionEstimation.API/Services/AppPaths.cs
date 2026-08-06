namespace ConstructionEstimation.API.Services;

/// <summary>
/// Resolves the locations the application writes to at runtime.
///
/// Everything used to be resolved against <c>ContentRootPath</c>, which works in
/// development (content root is the project source folder) but fails once the app
/// is installed under <c>C:\Program Files</c>, where the process cannot write.
///
/// When <c>Storage:DataPath</c> is configured — the installed build sets it to
/// <c>C:\ProgramData\BuildTakeoffPro</c> — writes go there instead. When it is
/// absent, <see cref="DataRoot"/> falls back to <c>ContentRootPath</c>, so
/// development and the existing IIS deployment behave exactly as before.
///
/// Note: <c>tessdata</c> is deliberately NOT resolved here. It ships alongside the
/// binaries and is read-only, so it stays under the content root.
/// </summary>
public class AppPaths
{
    public AppPaths(IWebHostEnvironment env, IConfiguration configuration)
    {
        var configured = configuration["Storage:DataPath"];
        IsDataPathConfigured = !string.IsNullOrWhiteSpace(configured);
        DataRoot = IsDataPathConfigured
            ? Path.GetFullPath(configured!)
            : env.ContentRootPath;
    }

    /// <summary>Base folder for all runtime-writable data.</summary>
    public string DataRoot { get; }

    /// <summary>
    /// True only when <c>Storage:DataPath</c> was set explicitly, i.e. this is an
    /// installer-provisioned deployment rather than development or the older IIS
    /// setup. Callers use this to avoid changing behaviour for existing installs.
    /// </summary>
    public bool IsDataPathConfigured { get; }

    /// <summary>Uploaded drawing PDFs.</summary>
    public string UploadsPath => Path.Combine(DataRoot, "Uploads");

    /// <summary>Scratch folder the Syncfusion PDF renderer writes to.</summary>
    public string PdfViewerTempPath => Path.Combine(DataRoot, "pdfviewer_temp");

    /// <summary>
    /// DataProtection key ring. These keys decrypt the stored licence key, so
    /// losing them locks the customer out until the licence is re-entered.
    /// </summary>
    public string KeysPath => Path.Combine(DataRoot, "keys");

    /// <summary>Full path of an uploaded drawing from its stored file name.</summary>
    public string UploadedFile(string fileName) => Path.Combine(UploadsPath, fileName);

    /// <summary>Creates the writable folders. Safe to call repeatedly.</summary>
    public void EnsureCreated()
    {
        Directory.CreateDirectory(UploadsPath);
        Directory.CreateDirectory(PdfViewerTempPath);

        // Only meaningful when this deployment owns its key ring; elsewhere
        // DataProtection keeps using its default location, so creating the
        // folder would just litter the project directory.
        if (IsDataPathConfigured)
            Directory.CreateDirectory(KeysPath);
    }
}
