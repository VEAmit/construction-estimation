[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [string]$LegacyIisSiteName,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = [System.IO.Path]::GetFullPath($LogPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
}

function Write-SetupLog {
    param([Parameter(Mandatory)][string]$Message)

    $entry = '[{0:yyyy-MM-dd HH:mm:ss}] {1}' -f (Get-Date), $Message
    Write-Host $Message
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Add-Content -LiteralPath $LogPath -Value $entry -Encoding UTF8
    }
}

trap {
    Write-SetupLog -Message ("ERROR: {0}" -f $_.Exception.Message)
    exit 1
}

function Remove-LegacyIisHosting {
    param([string]$SiteName)

    if ([string]::IsNullOrWhiteSpace($SiteName)) { return }
    $appCmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
    if (-not (Test-Path -LiteralPath $appCmd -PathType Leaf)) { return }

    & $appCmd list site "/name:$SiteName" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & $appCmd stop site "/site.name:$SiteName" 2>$null | Out-Null
        & $appCmd delete site "/site.name:$SiteName" | Out-Null
        Write-SetupLog -Message "Removed legacy IIS site '$SiteName'."
    }

    & $appCmd list apppool "/name:$SiteName" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & $appCmd stop apppool "/apppool.name:$SiteName" 2>$null | Out-Null
        & $appCmd delete apppool "/apppool.name:$SiteName" | Out-Null
        Write-SetupLog -Message "Removed legacy IIS application pool '$SiteName'."
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Application startup registration requires an elevated administrator process.'
}

$ApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw "Application executable was not found: $ApplicationPath"
}

$launcherPath = Join-Path $PSScriptRoot 'Start-Application.ps1'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Application launcher was not found: $launcherPath"
}

# Stop/remove a previous standalone version before checking the port. This is
# safe for upgrades and does not affect unrelated scheduled tasks or processes.
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Start-Sleep -Milliseconds 500
}

Remove-LegacyIisHosting -SiteName $LegacyIisSiteName

$listener = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port } |
    Select-Object -First 1
if ($null -ne $listener) {
    throw "HTTP port $Port is already in use. Run setup again and choose another port."
}

$applicationDirectory = Split-Path -Parent $ApplicationPath
$writableDirectories = @(
    (Join-Path $applicationDirectory 'Uploads'),
    (Join-Path $applicationDirectory 'Logs'),
    (Join-Path $applicationDirectory 'App_Data\DataProtection-Keys')
)
foreach ($directory in $writableDirectories) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$powershellPath = Join-Path $PSHOME 'powershell.exe'
$actionArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ApplicationPath "{1}" -Port {2}' -f `
    $launcherPath, $ApplicationPath, $Port
$action = New-ScheduledTaskAction `
    -Execute $powershellPath `
    -Argument $actionArguments `
    -WorkingDirectory $applicationDirectory
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the self-contained BuildTakeoff Pro web application.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-SetupLog -Message "Registered and started self-contained application task '$TaskName'."

$address = "http://127.0.0.1:$Port/"
$deadline = (Get-Date).AddMinutes(3)
$lastError = $null
do {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri $address -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
            Write-SetupLog -Message "BuildTakeoff Pro is ready at $address"
            exit 0
        }
    }
    catch {
        $lastError = $_.Exception.Message
    }
} while ((Get-Date) -lt $deadline)

$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
$taskResult = if ($null -eq $taskInfo) { 'unavailable' } else { $taskInfo.LastTaskResult }
throw "BuildTakeoff Pro did not become ready at $address. Task result: $taskResult. Last response: $lastError. Review App\Logs\standalone-error.log."
