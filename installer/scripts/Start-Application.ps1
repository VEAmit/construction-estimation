[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port
)

$ErrorActionPreference = 'Stop'
$ApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw "BuildTakeoff Pro executable was not found: $ApplicationPath"
}

$applicationDirectory = Split-Path -Parent $ApplicationPath
$logsDirectory = Join-Path $applicationDirectory 'Logs'
New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null

# Set production explicitly instead of inheriting a machine-wide developer
# environment variable. Kestrel serves both the API and the packaged React app.
$env:ASPNETCORE_ENVIRONMENT = 'Production'
$env:DOTNET_ENVIRONMENT = 'Production'

$standardOutput = Join-Path $logsDirectory 'standalone-output.log'
$standardError = Join-Path $logsDirectory 'standalone-error.log'
$process = Start-Process `
    -FilePath $ApplicationPath `
    -ArgumentList @('--urls', "http://127.0.0.1:$Port") `
    -WorkingDirectory $applicationDirectory `
    -RedirectStandardOutput $standardOutput `
    -RedirectStandardError $standardError `
    -NoNewWindow `
    -Wait `
    -PassThru

exit $process.ExitCode
