[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Configuration = 'Release',

    [ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')]
    [string]$Version = '1.0.5.2',

    [string]$InnoCompiler
)

$ErrorActionPreference = 'Stop'
$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$stagingRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot 'staging'))
$appStaging = [System.IO.Path]::GetFullPath((Join-Path $stagingRoot 'App'))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot 'Output'))
$compilerOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot 'CompilerOutput'))
$projectPath = Join-Path $repoRoot 'backend\ConstructionEstimation.API\ConstructionEstimation.API.csproj'
$issPath = Join-Path $scriptRoot 'BuildTakeoffPro.iss'

function Reset-GeneratedDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $expectedPrefix = $scriptRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a directory outside installer/: $resolved"
    }
    if ($resolved -eq $scriptRoot -or [string]::IsNullOrWhiteSpace((Split-Path $resolved -Leaf))) {
        throw "Refusing to clean unsafe path: $resolved"
    }

    if (Test-Path -LiteralPath $resolved) {
        # Clean generated contents without deleting the root directory itself.
        # A previously launched setup can keep a harmless directory handle open
        # even after its EXE has been moved, which must not block a fresh build.
        Get-ChildItem -LiteralPath $resolved -Force | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    }
    else {
        New-Item -ItemType Directory -Path $resolved -Force | Out-Null
    }
}

function Reset-InstallerOutputDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $expectedPrefix = $scriptRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a directory outside installer/: $resolved"
    }

    if (-not (Test-Path -LiteralPath $resolved)) {
        New-Item -ItemType Directory -Path $resolved -Force | Out-Null
        return
    }

    foreach ($item in @(Get-ChildItem -LiteralPath $resolved -Force)) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
        }
        catch [System.IO.IOException] {
            # A developer may have launched the previous generated setup EXE
            # directly from Output. Preserve only that locked EXE so a new
            # version can still be built; a later build removes it normally.
            if ($item.PSIsContainer -or $item.Extension -ne '.exe') { throw }
            Write-Warning "Previous installer is currently open and will be preserved: $($item.FullName)"
        }
    }
}

function Resolve-InnoCompiler {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        $candidate = [System.IO.Path]::GetFullPath($RequestedPath)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Inno Setup compiler was not found at: $candidate"
        }
        return $candidate
    }

    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }

    throw @'
Inno Setup 6 is required to create the installer EXE.
Install it once with:
  winget install --id JRSoftware.InnoSetup -e
Then run this build command again.
'@
}

Write-Host "Cleaning installer staging and Output folders..."
Reset-GeneratedDirectory -Path $stagingRoot
Reset-InstallerOutputDirectory -Path $outputRoot
Reset-GeneratedDirectory -Path $compilerOutputRoot

Write-Host "Publishing self-contained BuildTakeoff Pro ($Configuration, win-x64)..."
Push-Location $repoRoot
try {
    # The installed application hosts both the API and the React bundle directly
    # with Kestrel. Include the .NET runtime so a client machine does not need IIS,
    # the ASP.NET Core Hosting Bundle, or a separately installed .NET runtime.
    # Keep multiple files because the PDF/OCR packages contain native libraries.
    & dotnet publish $projectPath `
        -c $Configuration `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=false `
        -p:PublishReadyToRun=false `
        -o $appStaging
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

# The repository keeps a developer-friendly local connection in appsettings.json.
# Never package that machine-specific value: the installer writes the selected
# connection into appsettings.Production.json on the destination machine.
$baseSettingsPath = Join-Path $appStaging 'appsettings.json'
$baseSettings = Get-Content -LiteralPath $baseSettingsPath -Raw | ConvertFrom-Json
if (-not $baseSettings.ConnectionStrings) {
    $baseSettings | Add-Member -MemberType NoteProperty -Name ConnectionStrings -Value ([pscustomobject]@{})
}
$baseSettings.ConnectionStrings.DefaultConnection = ''
$baseSettings | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $baseSettingsPath -Encoding UTF8

# The standalone process runs under the Windows SYSTEM account. Keep ASP.NET
# Core Data Protection keys in the application data directory so encrypted
# license values survive application and Windows restarts.
$productionSettingsPath = Join-Path $appStaging 'appsettings.Production.json'
$productionSettings = Get-Content -LiteralPath $productionSettingsPath -Raw | ConvertFrom-Json
if (-not $productionSettings.DataProtection) {
    $productionSettings | Add-Member -MemberType NoteProperty -Name DataProtection -Value ([pscustomobject]@{})
}
$productionSettings.DataProtection | Add-Member `
    -MemberType NoteProperty `
    -Name KeysPath `
    -Value 'App_Data\DataProtection-Keys' `
    -Force
$productionSettings | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $productionSettingsPath -Encoding UTF8

$requiredFiles = @(
    (Join-Path $appStaging 'ConstructionEstimation.API.exe'),
    (Join-Path $appStaging 'hostfxr.dll'),
    (Join-Path $appStaging 'hostpolicy.dll'),
    (Join-Path $appStaging 'appsettings.Production.json'),
    (Join-Path $appStaging 'wwwroot\index.html'),
    (Join-Path $appStaging 'tessdata\eng.traineddata')
)
foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Publish validation failed; required file is missing: $requiredFile"
    }
}

$compiler = Resolve-InnoCompiler -RequestedPath $InnoCompiler
Write-Host "Compiling installer with $compiler..."
& $compiler "/DMyAppVersion=$Version" $issPath
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }

$compiledInstallers = @(Get-ChildItem -LiteralPath $compilerOutputRoot -Filter '*.exe' -File)
if ($compiledInstallers.Count -ne 1) {
    throw "Expected exactly one compiled installer EXE, found $($compiledInstallers.Count)."
}

$compiledInstaller = $compiledInstallers[0]
$finalInstallerPath = Join-Path $outputRoot $compiledInstaller.Name
Move-Item -LiteralPath $compiledInstaller.FullName -Destination $finalInstallerPath -Force
$installers = @(Get-ChildItem -LiteralPath $outputRoot -Filter $compiledInstaller.Name -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one installer EXE for version $Version, found $($installers.Count)."
}

$installer = $installers[0]
Write-Host ''
Write-Host 'Installer created successfully:' -ForegroundColor Green
Write-Host "  $($installer.FullName)"
Write-Host ("  Size: {0:N2} MB" -f ($installer.Length / 1MB))
