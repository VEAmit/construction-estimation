<#
.SYNOPSIS
    Installs BuildTakeoff Pro on this machine without the Setup.exe.

.DESCRIPTION
    Does exactly what the Inno Setup installer does, minus the wizard UI:
    copies the application, then runs configure.ps1 (data folders, config,
    database, Windows Service, health check).

    Use this to test on another machine before the Setup.exe exists, or to
    reinstall without rebuilding the installer.

.EXAMPLE
    # From an ADMIN PowerShell prompt, inside the copied installer folder:
    .\Install-Manual.ps1

.EXAMPLE
    .\Install-Manual.ps1 -Port 5050 -SqlInstance "MYPC\SQLEXPRESS"

.NOTES
    Requirements on the target machine:
      * Windows 64-bit
      * SQL Server (Express is fine) already installed
      * Administrator rights
    The .NET runtime is NOT required - the payload is self-contained.
#>
[CmdletBinding()]
param(
    [string] $InstallDir  = "$env:ProgramFiles\BuildTakeoff Pro",
    [string] $DataDir     = "$env:ProgramData\BuildTakeoffPro",
    [int]    $Port        = 5000,
    [string] $SqlInstance = '.\SQLEXPRESS',
    [string] $ServiceName = 'BuildTakeoffPro'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $here 'payload\app'
$scripts = Join-Path $here 'scripts'

function Write-Step { param([string] $m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# --- checks before touching anything -------------------------------------
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an Administrator PowerShell prompt (right-click > Run as administrator).'
}

if (-not (Test-Path (Join-Path $payload 'ConstructionEstimation.API.exe'))) {
    throw ("Application payload not found at $payload`n" +
           'Copy the whole installer folder, including payload\app, to this machine.')
}

Write-Step 'Checking SQL Server'
$sqlKey = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
if (Test-Path $sqlKey) {
    $instances = (Get-ItemProperty $sqlKey).PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS' } | Select-Object -ExpandProperty Name
    Write-Host "Found SQL instance(s): $($instances -join ', ')"
} else {
    Write-Warning 'No SQL Server instance detected. Install SQL Server Express first, then re-run this script.'
    if ((Read-Host 'Continue anyway? (y/N)') -ne 'y') { exit 1 }
}

# --- stop the service before overwriting files ---------------------------
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') {
    Write-Step "Stopping existing service '$ServiceName'"
    Stop-Service -Name $ServiceName -Force
    $svc.WaitForStatus('Stopped', '00:01:00')
}

# --- copy ----------------------------------------------------------------
Write-Step "Copying application to $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# /MIR would delete appsettings.Production.json on upgrade, taking the licence
# config and connection string with it, so copy without mirroring.
& robocopy $payload $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

& robocopy $scripts (Join-Path $InstallDir 'scripts') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy of scripts failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0   # robocopy uses 0-7 for success; reset so it is not read as failure

# --- configure -----------------------------------------------------------
Write-Step 'Configuring database and service'
& powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $InstallDir 'scripts\configure.ps1') `
    -InstallDir $InstallDir -DataDir $DataDir -Port $Port `
    -SqlInstance $SqlInstance -ServiceName $ServiceName
if ($LASTEXITCODE -ne 0) { throw "Configuration failed with exit code $LASTEXITCODE" }

Write-Host "`nInstalled. Open http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host "Data:    $DataDir"
Write-Host "Logs:    $DataDir\Logs"
Write-Host "Service: $ServiceName  (Get-Service $ServiceName)"
