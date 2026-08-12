[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskName,
    [string]$ApplicationPath
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Normally stopping the scheduled task ends its complete process tree. As a
# fallback, terminate only the executable installed at this exact path.
if (-not [string]::IsNullOrWhiteSpace($ApplicationPath)) {
    $resolvedApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
    Start-Sleep -Milliseconds 500
    Get-CimInstance Win32_Process -Filter "Name = 'ConstructionEstimation.API.exe'" |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath($_.ExecutablePath),
                $resolvedApplicationPath,
                [System.StringComparison]::OrdinalIgnoreCase)
        } |
        ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
}
