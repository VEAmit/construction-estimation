<#
.SYNOPSIS
    Builds the BuildTakeoff Pro installer.

.DESCRIPTION
    1. Publishes the API self-contained for win-x64. The project's own
       BuildAndCopyFrontendForPublish target runs `npm run build` and copies the
       React bundle into wwwroot, so the frontend is not built separately here.
    2. Compiles installer\BuildTakeoffPro.iss with Inno Setup.

    Output: installer\output\BuildTakeoffPro-Setup-<version>.exe

.PARAMETER SkipPublish
    Reuse an existing payload. Useful when iterating on the .iss only.

.NOTES
    Build machine needs: .NET 8 SDK, Node.js, Inno Setup 6.
#>
[CmdletBinding()]
param(
    [switch] $SkipPublish,
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Split-Path -Parent $here
$project    = Join-Path $repoRoot 'backend\ConstructionEstimation.API\ConstructionEstimation.API.csproj'
$payloadDir = Join-Path $here 'payload\app'
$outputDir  = Join-Path $here 'output'
$issFile    = Join-Path $here 'BuildTakeoffPro.iss'

function Write-Step { param([string] $m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# Version comes from frontend/src/version.js, the single source of truth already
# used by the UI, so the installer can never disagree with the app's own banner.
$versionFile = Join-Path $repoRoot 'frontend\src\version.js'
$versionMatch = Select-String -Path $versionFile -Pattern "APP_VERSION\s*=\s*'([^']+)'"
if (-not $versionMatch) { throw "Could not read APP_VERSION from $versionFile" }
$version = $versionMatch.Matches[0].Groups[1].Value
Write-Host "BuildTakeoff Pro version $version" -ForegroundColor Green

if (-not $SkipPublish) {
    Write-Step 'Publishing self-contained (win-x64)'

    if (Test-Path $payloadDir) { Remove-Item $payloadDir -Recurse -Force }
    New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null

    # Self-contained so no .NET runtime install is required on the target.
    # Not trimmed: Syncfusion, Tesseract and EF all rely on reflection, and
    # trimming silently removes types they resolve at runtime.
    & dotnet publish $project `
        --configuration $Configuration `
        --runtime win-x64 `
        --self-contained true `
        -p:PublishSingleFile=false `
        --output $payloadDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

    # Fail loudly rather than shipping a broken installer: these are the pieces
    # that have gone missing from publish output before.
    $required = @(
        'ConstructionEstimation.API.exe',
        'wwwroot\index.html',
        'tessdata\eng.traineddata'
    )
    foreach ($item in $required) {
        if (-not (Test-Path (Join-Path $payloadDir $item))) {
            throw "Publish output is missing '$item' - refusing to build the installer."
        }
    }

    # appsettings.json ships with a developer connection string pointing at a
    # machine that does not exist for the customer. Production settings are
    # written by configure.ps1 at install time and take precedence, but leaving
    # the developer file untouched here keeps the two environments identical.
    Write-Host 'Publish payload verified.' -ForegroundColor Green
}

Write-Step 'Checking the SQL Server Express prerequisite'

# Bundled so a machine with no SQL Server still installs in one click, offline.
# Cached between builds: it is 266 MB and never changes.
$prereqDir = Join-Path $here 'prereq'
$sqlExpr   = Join-Path $prereqDir 'SQLEXPR_x64_ENU.exe'
$sqlUrl    = 'https://download.microsoft.com/download/3/8/d/38de7036-2433-4207-8eae-06e247e17b25/SQLEXPR_x64_ENU.exe'

New-Item -ItemType Directory -Path $prereqDir -Force | Out-Null

# A partial download from an interrupted build would produce a broken installer,
# so anything suspiciously small is re-fetched rather than trusted.
if ((Test-Path $sqlExpr) -and ((Get-Item $sqlExpr).Length -lt 200MB)) {
    Write-Warning 'Cached SQL Express installer looks incomplete - downloading again.'
    Remove-Item $sqlExpr -Force
}

if (-not (Test-Path $sqlExpr)) {
    Write-Host "Downloading SQL Server Express (266 MB, one time)..."
    $ProgressPreference = 'SilentlyContinue'   # progress bar makes this far slower
    Invoke-WebRequest -Uri $sqlUrl -OutFile $sqlExpr -UseBasicParsing
    $ProgressPreference = 'Continue'
}
Write-Host ("SQL Express prerequisite: {0:N0} MB" -f ((Get-Item $sqlExpr).Length / 1MB)) -ForegroundColor Green

Write-Step 'Compiling the installer'

$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    'C:\InnoSetup6\ISCC.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
    throw ("Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php " +
           "or add ISCC.exe to the paths checked in this script.")
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

& $iscc "/DAppVersion=$version" "/O$outputDir" $issFile
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }

$setup = Get-ChildItem $outputDir -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "`nInstaller: $($setup.FullName)" -ForegroundColor Green
Write-Host ("Size: {0:N1} MB" -f ($setup.Length / 1MB)) -ForegroundColor Green
