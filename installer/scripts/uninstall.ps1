<#
.SYNOPSIS
    Removes the BuildTakeoff Pro Windows Service.

.DESCRIPTION
    Run by the uninstaller before files are deleted. Deliberately does NOT touch
    the data directory or the database - those hold the customer's uploaded
    drawings and takeoff data. The installer asks separately about the data
    directory; the database is always left alone.

    Safe to run when the service is already gone.
#>
[CmdletBinding()]
param(
    [string] $ServiceName = 'BuildTakeoffPro'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "[BuildTakeoff] Service '$ServiceName' not present - nothing to remove."
    exit 0
}

if ($service.Status -ne 'Stopped') {
    Write-Host "[BuildTakeoff] Stopping service '$ServiceName'"
    try {
        Stop-Service -Name $ServiceName -Force
        $service.WaitForStatus('Stopped', '00:01:00')
    } catch {
        Write-Warning "Could not stop '$ServiceName' cleanly: $($_.Exception.Message)"
    }
}

Write-Host "[BuildTakeoff] Removing service '$ServiceName'"
& sc.exe delete $ServiceName | Out-Null

# The SCM keeps the entry until every handle closes; a brief pause avoids a
# "marked for deletion" failure if the installer immediately reinstalls.
Start-Sleep -Seconds 2

exit 0
