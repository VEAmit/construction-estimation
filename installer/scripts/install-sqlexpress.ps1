<#
.SYNOPSIS
    Installs SQL Server Express silently, if it is not already present.

.DESCRIPTION
    Called by the installer before configure.ps1 when no SQL Server instance is
    detected. Kept separate because it is slow (several minutes), optional, and
    worth being able to re-run on its own when it fails.

    The instance is created with:
      * Windows authentication only - the app connects with Trusted_Connection,
        so no SA password needs to be invented, stored, or leaked.
      * Both BUILTIN\Administrators and NT AUTHORITY\SYSTEM as sysadmin.
        SYSTEM matters because the BuildTakeoff Pro service runs as LocalSystem;
        without it the service could not reach its own database.

.NOTES
    Requires administrator. Exits non-zero on failure.
    Exit code 3010 from SQL setup means "success, reboot required" and is
    treated as success here.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $SetupExe,
    [string] $InstanceName = 'SQLEXPRESS'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string] $m) Write-Host "[SQL] $m" }

function Get-SqlInstances {
    $key = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
    if (-not (Test-Path $key)) { return @() }
    return (Get-ItemProperty $key).PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS' } | Select-Object -ExpandProperty Name
}

$existing = Get-SqlInstances
if ($existing.Count -gt 0) {
    Write-Step "SQL Server already present ($($existing -join ', ')) - skipping installation."
    exit 0
}

if (-not (Test-Path $SetupExe)) {
    throw "SQL Server Express installer not found at $SetupExe"
}

Write-Step "Installing SQL Server Express instance '$InstanceName'. This takes several minutes..."

# /QS shows a progress window with no prompts. Fully silent (/Q) looks frozen
# for 5+ minutes, which reads as a hung installer to the person watching.
$arguments = @(
    '/QS'
    '/IACCEPTSQLSERVERLICENSETERMS'
    '/ACTION=Install'
    '/FEATURES=SQLEngine'
    "/INSTANCENAME=$InstanceName"
    '/SQLSVCACCOUNT="NT AUTHORITY\NETWORK SERVICE"'
    '/SQLSYSADMINACCOUNTS="BUILTIN\ADMINISTRATORS" "NT AUTHORITY\SYSTEM"'
    '/TCPENABLED=1'
    '/UPDATEENABLED=0'
)

$process = Start-Process -FilePath $SetupExe -ArgumentList $arguments -Wait -PassThru
$code = $process.ExitCode

if ($code -eq 3010) {
    Write-Step 'SQL Server Express installed. A reboot is pending but is not required to continue.'
} elseif ($code -ne 0) {
    throw ("SQL Server Express setup failed with exit code $code. " +
           'See C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt for details.')
} else {
    Write-Step 'SQL Server Express installed.'
}

# Setup returning success does not guarantee the service is accepting
# connections yet; configure.ps1 runs straight after and would fail.
$serviceName = "MSSQL`$$InstanceName"
Write-Step "Waiting for service $serviceName to start"
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Running') { Start-Service -Name $serviceName -ErrorAction SilentlyContinue }
        if ((Get-Service -Name $serviceName).Status -eq 'Running') {
            Write-Step 'SQL Server is running.'
            exit 0
        }
    }
    Start-Sleep -Seconds 5
}

throw "SQL Server service '$serviceName' did not reach Running state."
