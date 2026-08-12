[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = [System.IO.Path]::GetFullPath($LogPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
}

function Write-StopLog {
    param([Parameter(Mandatory)][string]$Message)

    $entry = '[{0:yyyy-MM-dd HH:mm:ss}] {1}' -f (Get-Date), $Message
    Write-Host $Message
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Add-Content -LiteralPath $LogPath -Value $entry -Encoding UTF8
    }
}

function Get-InstalledApplicationProcesses {
    param([Parameter(Mandatory)][string]$ResolvedApplicationPath)

    $allProcesses = @(Get-CimInstance Win32_Process `
        -Filter "Name = 'ConstructionEstimation.API.exe'" `
        -ErrorAction SilentlyContinue)
    return @($allProcesses | Where-Object {
        (-not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath($_.ExecutablePath),
                $ResolvedApplicationPath,
                [System.StringComparison]::OrdinalIgnoreCase)) -or
        (-not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
            $_.CommandLine.IndexOf(
                $ResolvedApplicationPath,
                [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}

trap {
    Write-StopLog -Message ("ERROR: {0}" -f $_.Exception.Message)
    exit 1
}

$resolvedApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)

# Stop and remove the startup task first. Older standalone installers launched
# the API as a child of PowerShell, so ending the task alone did not always end
# the child process or release its loaded DLL files.
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-StopLog -Message "Stopped existing application task '$TaskName'."
}

$deadline = (Get-Date).AddSeconds(20)
do {
    $processes = @(Get-InstalledApplicationProcesses `
        -ResolvedApplicationPath $resolvedApplicationPath)
    foreach ($process in $processes) {
        Write-StopLog -Message (
            "Stopping existing BuildTakeoff Pro process {0} before upgrade." -f
            $process.ProcessId)
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($processes.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

$remainingProcesses = @(Get-InstalledApplicationProcesses `
    -ResolvedApplicationPath $resolvedApplicationPath)
if ($remainingProcesses.Count -gt 0) {
    throw "The existing BuildTakeoff Pro process could not be stopped. Process ID(s): $($remainingProcesses.ProcessId -join ', ')."
}

# Allow Windows a brief moment to release loaded assemblies after process exit.
Start-Sleep -Milliseconds 750
Write-StopLog -Message 'Existing application is stopped and ready to be upgraded.'

