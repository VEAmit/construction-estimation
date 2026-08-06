<#
.SYNOPSIS
    Post-install configuration for BuildTakeoff Pro.

.DESCRIPTION
    Run by the Inno Setup installer after files are copied. Kept as a standalone
    script (rather than Inno Pascal) so it can be tested and re-run on its own.

    Steps:
      1. Create the writable data directories and grant the service account access
      2. Write appsettings.Production.json, MERGING into the shipped file so the
         Licensing section is preserved
      3. Create the database and grant the service account rights
         (schema itself is left to EF migrations at first start)
      4. Register and start the Windows Service
      5. Wait for the app to answer on its port

    Safe to re-run: every step is idempotent, and an upgrade re-runs it.

.NOTES
    Requires administrator. Exits non-zero on failure so the installer can report it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InstallDir,
    [Parameter(Mandatory)] [string] $DataDir,
    [int]    $Port        = 5000,
    [string] $SqlInstance = '.\SQLEXPRESS',
    [string] $Database    = 'ConstructionEstimationDB',
    [string] $ServiceName = 'BuildTakeoffPro',
    [string] $ServiceAccount = 'NT AUTHORITY\SYSTEM'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string] $Message) Write-Host "[BuildTakeoff] $Message" }

# --------------------------------------------------------------------------
# 1. Data directories
# --------------------------------------------------------------------------
Write-Step "Creating data directories under $DataDir"
foreach ($sub in @('', 'Uploads', 'Logs', 'pdfviewer_temp', 'keys')) {
    $path = if ($sub) { Join-Path $DataDir $sub } else { $DataDir }
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
}

# The service writes uploads, logs and DataProtection keys here. Without this
# grant the app starts but fails the first upload.
Write-Step "Granting '$ServiceAccount' write access to the data directory"
$acl  = Get-Acl $DataDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $ServiceAccount, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -Path $DataDir -AclObject $acl

# --------------------------------------------------------------------------
# 2. appsettings.Production.json
# --------------------------------------------------------------------------
$configPath = Join-Path $InstallDir 'appsettings.Production.json'
Write-Step "Writing $configPath"

# Start from the shipped file so the Licensing block survives. Overwriting it
# outright would wipe the licence validation URL and break activation.
$config = if (Test-Path $configPath) {
    Get-Content $configPath -Raw | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}

function Set-Prop {
    param($Object, [string] $Name, $Value)
    if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

$connectionString =
    "Server=$SqlInstance;Database=$Database;Trusted_Connection=True;" +
    "MultipleActiveResultSets=true;TrustServerCertificate=True"

# A per-machine JWT signing key. The value in appsettings.json is a literal
# shared by every build, so anyone with the source could mint valid tokens.
# Only generated once - regenerating on upgrade would sign out every user.
$existingJwt = $null
if ($config.PSObject.Properties.Name -contains 'Jwt') {
    $existingJwt = $config.Jwt
}
if ($null -ne $existingJwt -and
    $existingJwt.PSObject.Properties.Name -contains 'Key' -and
    -not [string]::IsNullOrWhiteSpace($existingJwt.Key)) {
    Write-Step 'Keeping the existing JWT key (upgrade)'
    $jwtKey = $existingJwt.Key
} else {
    Write-Step 'Generating a machine-specific JWT key'
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwtKey = [Convert]::ToBase64String($bytes)
}

Set-Prop $config 'ConnectionStrings' ([pscustomobject]@{ DefaultConnection = $connectionString })
Set-Prop $config 'Jwt'               ([pscustomobject]@{ Key = $jwtKey })
Set-Prop $config 'Storage'           ([pscustomobject]@{ DataPath = $DataDir })
Set-Prop $config 'EnableSwagger'     $false
Set-Prop $config 'Kestrel' ([pscustomobject]@{
    Endpoints = [pscustomobject]@{
        # Loopback only: single-user desktop install, so no firewall rule and
        # no exposure to the network.
        Http = [pscustomobject]@{ Url = "http://127.0.0.1:$Port" }
    }
})
Set-Prop $config 'Serilog' ([pscustomobject]@{
    WriteTo = @(
        [pscustomobject]@{
            Name = 'File'
            Args = [pscustomobject]@{
                path            = (Join-Path $DataDir 'Logs\log-.txt')
                rollingInterval = 'Day'
            }
        }
    )
})

$config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8

# --------------------------------------------------------------------------
# 3. Database
# --------------------------------------------------------------------------
function Invoke-Sql {
    param([string] $ConnectionString, [string] $Sql)
    $conn = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Sql
        $cmd.CommandTimeout = 120
        [void]$cmd.ExecuteNonQuery()
    } finally { $conn.Dispose() }
}

$masterCs = "Server=$SqlInstance;Database=master;Trusted_Connection=True;TrustServerCertificate=True"

Write-Step "Provisioning database '$Database' on $SqlInstance"
Invoke-Sql $masterCs @"
IF DB_ID(N'$Database') IS NULL
    CREATE DATABASE [$Database];
"@

# The service runs as $ServiceAccount, which needs its own SQL login. Schema
# creation is deliberately left to EF migrations on first start - hand-written
# schema SQL is what caused the column drift we had to repair in the field.
Write-Step "Granting '$ServiceAccount' access to the database"
Invoke-Sql $masterCs @"
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$ServiceAccount')
    CREATE LOGIN [$ServiceAccount] FROM WINDOWS;
"@

$dbCs = "Server=$SqlInstance;Database=$Database;Trusted_Connection=True;TrustServerCertificate=True"
Invoke-Sql $dbCs @"
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$ServiceAccount')
    CREATE USER [$ServiceAccount] FOR LOGIN [$ServiceAccount];
ALTER ROLE db_owner ADD MEMBER [$ServiceAccount];
"@

# --------------------------------------------------------------------------
# 4. Windows Service
# --------------------------------------------------------------------------
$exePath = Join-Path $InstallDir 'ConstructionEstimation.API.exe'
if (-not (Test-Path $exePath)) { throw "Application executable not found at $exePath" }

# --environment is read from the command line by WebApplication.CreateBuilder(args),
# which avoids setting a machine-wide ASPNETCORE_ENVIRONMENT variable.
$binPath = '"{0}" --environment Production' -f $exePath

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Service '$ServiceName' exists - stopping for upgrade"
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', '00:01:00')
    }
    & sc.exe config $ServiceName binPath= $binPath start= auto obj= "$ServiceAccount" | Out-Null
} else {
    Write-Step "Registering service '$ServiceName'"
    & sc.exe create $ServiceName binPath= $binPath start= auto obj= "$ServiceAccount" `
        DisplayName= "BuildTakeoff Pro" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed with exit code $LASTEXITCODE" }
}

& sc.exe description $ServiceName "BuildTakeoff Pro estimation and digital takeoff service." | Out-Null
# Restart automatically if the process dies, so a crash does not silently take
# the application offline until the next reboot.
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Write-Step "Starting service '$ServiceName'"
Start-Service -Name $ServiceName

# --------------------------------------------------------------------------
# 5. Health check
# --------------------------------------------------------------------------
Write-Step "Waiting for the application on port $Port"
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # First start also runs EF migrations, which can take a while on a cold
        # SQL Express instance. Keep polling until the deadline.
    }
    Start-Sleep -Seconds 3
}

if (-not $ready) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $status = if ($svc) { $svc.Status } else { 'not installed' }
    throw ("BuildTakeoff Pro did not respond on port $Port within 90 seconds " +
           "(service status: $status). Check $DataDir\Logs for details.")
}

Write-Step "Ready at http://127.0.0.1:$Port/"
exit 0
