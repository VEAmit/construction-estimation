[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$SettingsFile,
    [string]$Server,
    [string]$Database,
    [ValidateSet('Windows', 'Sql')]
    [string]$Authentication,
    [string]$UserName,
    [string]$Password,
    [string]$TaskName = 'BuildTakeoffPro',
    [string]$LogPath,
    [switch]$SkipConnectionTest
)

$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = [System.IO.Path]::GetFullPath($LogPath)
    $logDirectory = Split-Path -Parent $LogPath
    if (-not [string]::IsNullOrWhiteSpace($logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
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

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot '..\App\appsettings.Production.json'
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertFrom-SecureValue {
    param([Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function New-ConnectionString {
    param(
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][string]$DatabaseName,
        [Parameter(Mandatory)][string]$AuthMode,
        [string]$SqlUser,
        [string]$SqlPassword
    )

    $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
    $builder['Data Source'] = $ServerName.Trim()
    $builder['Initial Catalog'] = $DatabaseName.Trim()
    $builder['MultipleActiveResultSets'] = $true
    $builder['TrustServerCertificate'] = $true
    $builder['Encrypt'] = $false

    if ($AuthMode -eq 'Windows') {
        $builder['Integrated Security'] = $true
    }
    else {
        if ([string]::IsNullOrWhiteSpace($SqlUser)) { throw 'SQL user name is required.' }
        if ([string]::IsNullOrWhiteSpace($SqlPassword)) { throw 'SQL password is required.' }
        $builder['User ID'] = $SqlUser
        $builder['Password'] = $SqlPassword
        $builder['Integrated Security'] = $false
    }

    return $builder.ConnectionString
}

function Test-IsSqlLocationFailure {
    param([Parameter(Mandatory)][Exception]$Exception)

    $message = $Exception.ToString()
    return $message -match '(?i)network-related|instance-specific|server was not found|not accessible|error:\s*(2|26|40|53)|could not open a connection|SQL Network Interfaces'
}

function Test-IsGenericLocalSqlServer {
    param([Parameter(Mandatory)][string]$ServerName)

    $value = $ServerName.Trim()
    if ($value.StartsWith('tcp:', [System.StringComparison]::OrdinalIgnoreCase) -or
        $value.Contains('\') -or $value.Contains(',')) {
        return $false
    }

    return (Test-IsLocalSqlServer -ServerName $value)
}

function ConvertTo-LocalSqlAlias {
    param([Parameter(Mandatory)][string]$ServerName)

    $value = $ServerName.Trim()
    if ($value.StartsWith('tcp:', [System.StringComparison]::OrdinalIgnoreCase) -or
        $value.Contains(',')) {
        return $value
    }

    $parts = $value -split '\\', 2
    if (-not (Test-IsLocalSqlServer -ServerName $value)) { return $value }
    if ($parts.Count -eq 2 -and -not [string]::IsNullOrWhiteSpace($parts[1])) {
        return ".\$($parts[1])"
    }
    return '.'
}

function Get-LocalSqlServerCandidates {
    $instanceNames = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)

    $registryPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL'
    )
    foreach ($registryPath in $registryPaths) {
        if (-not (Test-Path -LiteralPath $registryPath)) { continue }
        $properties = Get-ItemProperty -LiteralPath $registryPath
        foreach ($property in $properties.PSObject.Properties) {
            if ($property.Name -notlike 'PS*') {
                [void]$instanceNames.Add($property.Name)
            }
        }
    }

    foreach ($service in @(Get-Service -Name 'MSSQLSERVER', 'MSSQL$*' -ErrorAction SilentlyContinue)) {
        if ($service.Name -eq 'MSSQLSERVER') {
            [void]$instanceNames.Add('MSSQLSERVER')
        }
        elseif ($service.Name.StartsWith('MSSQL$', [StringComparison]::OrdinalIgnoreCase)) {
            [void]$instanceNames.Add($service.Name.Substring(6))
        }
    }

    $candidates = [Collections.Generic.List[string]]::new()
    if ($instanceNames.Contains('MSSQLSERVER')) { $candidates.Add('.') }
    foreach ($instanceName in ($instanceNames | Sort-Object)) {
        if ($instanceName -ne 'MSSQLSERVER') {
            $candidates.Add(".\$instanceName")
        }
    }
    return $candidates.ToArray()
}

function Start-LocalSqlServerService {
    param([Parameter(Mandatory)][string]$ServerName)

    if (-not (Test-IsLocalSqlServer -ServerName $ServerName)) { return }
    $localAlias = ConvertTo-LocalSqlAlias -ServerName $ServerName
    if ($localAlias.Contains('\')) {
        $instanceName = ($localAlias -split '\\', 2)[1]
        $serviceName = "MSSQL`$$instanceName"
    }
    else {
        $serviceName = 'MSSQLSERVER'
    }

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $service -or $service.Status -eq 'Running') { return }

    Write-SetupLog -Message "Starting local SQL Server service '$serviceName'."
    try {
        Start-Service -Name $serviceName -ErrorAction Stop
        $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }
    catch {
        throw "Local SQL Server instance '$localAlias' was found, but service '$serviceName' could not be started. Start it in SQL Server Configuration Manager and retry setup. $($_.Exception.Message)"
    }
}

function Test-DatabaseServerConnection {
    param(
        [Parameter(Mandatory)][string]$ConnectionString,
        [int]$TimeoutSeconds = 12
    )

    # Connect to master so first installation can succeed before the application
    # creates/migrates its target database.
    $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
    $targetDatabase = [string]$builder['Initial Catalog']
    $builder['Initial Catalog'] = 'master'
    $builder['Connect Timeout'] = $TimeoutSeconds
    $connection = [System.Data.SqlClient.SqlConnection]::new($builder.ConnectionString)
    try {
        $connection.Open()
        Write-Host "Database server connection succeeded (target database: $targetDatabase)." -ForegroundColor Green
    }
    finally {
        $connection.Dispose()
    }
}

function Resolve-DatabaseConnectionString {
    param([Parameter(Mandatory)][string]$ConnectionString)

    $originalBuilder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
    $requestedServer = [string]$originalBuilder['Data Source']
    $normalizedServer = ConvertTo-LocalSqlAlias -ServerName $requestedServer
    $genericLocalServer = Test-IsGenericLocalSqlServer -ServerName $requestedServer

    $candidateServers = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @($normalizedServer)) {
        if ($seen.Add($candidate)) { $candidateServers.Add($candidate) }
    }
    if ($genericLocalServer) {
        foreach ($candidate in @(Get-LocalSqlServerCandidates)) {
            if ($seen.Add($candidate)) { $candidateServers.Add($candidate) }
        }
    }

    $attemptedServers = [Collections.Generic.List[string]]::new()
    $lastException = $null
    foreach ($candidateServer in $candidateServers) {
        $candidateBuilder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
        $candidateBuilder['Data Source'] = $candidateServer
        $attemptedServers.Add($candidateServer)

        try {
            Start-LocalSqlServerService -ServerName $candidateServer
            Test-DatabaseServerConnection -ConnectionString $candidateBuilder.ConnectionString
            if (-not [string]::Equals($requestedServer, $candidateServer, [StringComparison]::OrdinalIgnoreCase)) {
                Write-SetupLog -Message "Resolved SQL Server '$requestedServer' to local instance '$candidateServer'."
            }
            return $candidateBuilder.ConnectionString
        }
        catch {
            $lastException = $_.Exception
            Write-SetupLog -Message "SQL Server connection attempt failed for '$candidateServer': $($lastException.Message)"

            # Authentication/permission/certificate errors are authoritative.
            # Only an address/instance failure is eligible for local discovery.
            if (-not (Test-IsSqlLocationFailure -Exception $lastException)) {
                throw
            }
        }
    }

    $availableInstances = @(Get-LocalSqlServerCandidates)
    $availableText = if ($availableInstances.Count -eq 0) {
        'No local SQL Server Database Engine instance was detected. Install/start SQL Server, or enter a reachable remote server.'
    }
    else {
        "Detected local instance(s): $($availableInstances -join ', ')."
    }
    throw "Could not connect to SQL Server. Attempted: $($attemptedServers -join ', '). $availableText Verify the selected instance and ensure the SQL Server service is running. Last error: $($lastException.Message)"
}

function Test-IsLocalSqlServer {
    param([Parameter(Mandatory)][string]$ServerName)

    $value = $ServerName.Trim()
    if ($value.StartsWith('tcp:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $value = $value.Substring(4)
    }
    if ($value.StartsWith('(localdb)', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $hostName = ($value -split '[\\,]', 2)[0].Trim()
    $localNames = @('.', '(local)', 'localhost', '127.0.0.1', '::1', $env:COMPUTERNAME)
    return $localNames -contains $hostName.ToLowerInvariant() -or
        $localNames -contains $hostName.ToUpperInvariant()
}

function ConvertTo-SqlIdentifier {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value.Length -gt 128 -or $Value.IndexOf([char]0) -ge 0) {
        throw "SQL identifier is invalid or longer than 128 characters: $Value"
    }
    return '[' + $Value.Replace(']', ']]') + ']'
}

function Initialize-WindowsAuthenticationDatabase {
    param([Parameter(Mandatory)][string]$ConnectionString)

    $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
    if (-not [bool]$builder['Integrated Security']) { return }

    $serverName = [string]$builder['Data Source']
    if (-not (Test-IsLocalSqlServer -ServerName $serverName)) {
        throw 'Automatic Windows authentication supports SQL Server installed on this computer. Use SQL Server authentication for a remote SQL Server.'
    }

    $databaseName = [string]$builder['Initial Catalog']
    if ([string]::IsNullOrWhiteSpace($databaseName)) {
        throw 'The Windows-authentication connection does not contain a target database name.'
    }

    # The self-contained application is started by Task Scheduler as LocalSystem.
    # Resolve the well-known SID so this also works on non-English Windows.
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $runtimeAccount = $systemSid.Translate([Security.Principal.NTAccount]).Value
    $databaseIdentifier = ConvertTo-SqlIdentifier -Value $databaseName
    $accountIdentifier = ConvertTo-SqlIdentifier -Value $runtimeAccount

    $masterBuilder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
    $masterBuilder['Initial Catalog'] = 'master'
    $masterBuilder['Connect Timeout'] = 20
    $masterConnection = [System.Data.SqlClient.SqlConnection]::new($masterBuilder.ConnectionString)
    try {
        $masterConnection.Open()

        $databaseCommand = $masterConnection.CreateCommand()
        $databaseCommand.CommandText = "IF DB_ID(@DatabaseName) IS NULL CREATE DATABASE $databaseIdentifier;"
        [void]$databaseCommand.Parameters.Add('@DatabaseName', [System.Data.SqlDbType]::NVarChar, 128)
        $databaseCommand.Parameters['@DatabaseName'].Value = $databaseName
        [void]$databaseCommand.ExecuteNonQuery()

        $loginCommand = $masterConnection.CreateCommand()
        $loginCommand.CommandText = @"
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE [name] = @AccountName)
    CREATE LOGIN $accountIdentifier FROM WINDOWS;
"@
        [void]$loginCommand.Parameters.Add('@AccountName', [System.Data.SqlDbType]::NVarChar, 256)
        $loginCommand.Parameters['@AccountName'].Value = $runtimeAccount
        [void]$loginCommand.ExecuteNonQuery()
    }
    catch {
        throw "Windows authentication connected successfully, but setup could not create/configure database '$databaseName' for the application identity. Run setup using a Windows account with SQL Server database and login administration rights. $($_.Exception.Message)"
    }
    finally {
        $masterConnection.Dispose()
    }

    $databaseBuilder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($ConnectionString)
    $databaseBuilder['Initial Catalog'] = $databaseName
    $databaseBuilder['Connect Timeout'] = 20
    $databaseConnection = [System.Data.SqlClient.SqlConnection]::new($databaseBuilder.ConnectionString)
    try {
        $databaseConnection.Open()
        $userCommand = $databaseConnection.CreateCommand()
        $userCommand.CommandText = @"
IF DATABASE_PRINCIPAL_ID(@AccountName) IS NULL
    CREATE USER $accountIdentifier FOR LOGIN $accountIdentifier;
IF IS_ROLEMEMBER(N'db_owner', @AccountName) <> 1 OR IS_ROLEMEMBER(N'db_owner', @AccountName) IS NULL
    ALTER ROLE [db_owner] ADD MEMBER $accountIdentifier;
"@
        [void]$userCommand.Parameters.Add('@AccountName', [System.Data.SqlDbType]::NVarChar, 256)
        $userCommand.Parameters['@AccountName'].Value = $runtimeAccount
        [void]$userCommand.ExecuteNonQuery()
    }
    catch {
        throw "Setup created database '$databaseName', but could not grant its application identity access. $($_.Exception.Message)"
    }
    finally {
        $databaseConnection.Dispose()
    }

    Write-SetupLog -Message "Windows authentication configured for the local application identity on database '$databaseName'."
}

$interactive = [string]::IsNullOrWhiteSpace($SettingsFile) -and
    [string]::IsNullOrWhiteSpace($Server)

if ($interactive -and -not (Test-IsAdministrator)) {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-ConfigPath', ('"{0}"' -f $ConfigPath),
        '-TaskName', ('"{0}"' -f $TaskName)
    ) -join ' '
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        $arguments += ' -LogPath "{0}"' -f $LogPath
    }
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

if (-not [string]::IsNullOrWhiteSpace($SettingsFile)) {
    $settingsPath = [System.IO.Path]::GetFullPath($SettingsFile)
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $connectionString = [string]$settings.ConnectionStrings.DefaultConnection
    if ([string]::IsNullOrWhiteSpace($connectionString)) {
        throw 'The installer database settings file does not contain DefaultConnection.'
    }
}
else {
    if ($interactive) {
        Write-Host 'BuildTakeoff Pro - Database Configuration' -ForegroundColor Cyan
        Write-Host 'This updates only the database connection and preserves licensing/application settings.'
        Write-Host ''

        $Server = Read-Host 'SQL Server name or address (example: SERVER\INSTANCE or 10.0.0.5)'
        $Database = Read-Host 'Database name [ConstructionEstimationDB]'
        if ([string]::IsNullOrWhiteSpace($Database)) { $Database = 'ConstructionEstimationDB' }
        $Authentication = Read-Host 'Authentication type: Sql or Windows [Sql]'
        if ([string]::IsNullOrWhiteSpace($Authentication)) { $Authentication = 'Sql' }
        if ($Authentication -notin @('Sql', 'Windows')) {
            throw "Authentication must be 'Sql' or 'Windows'."
        }
        if ($Authentication -eq 'Sql') {
            $UserName = Read-Host 'SQL user name'
            $securePassword = Read-Host 'SQL password' -AsSecureString
            $Password = ConvertFrom-SecureValue -Value $securePassword
        }
    }

    if ([string]::IsNullOrWhiteSpace($Server)) { throw 'SQL Server is required.' }
    if ([string]::IsNullOrWhiteSpace($Database)) { throw 'Database name is required.' }
    if ([string]::IsNullOrWhiteSpace($Authentication)) { $Authentication = 'Sql' }
    $connectionString = New-ConnectionString -ServerName $Server -DatabaseName $Database `
        -AuthMode $Authentication -SqlUser $UserName -SqlPassword $Password
}

if (-not $SkipConnectionTest) {
    $connectionString = Resolve-DatabaseConnectionString -ConnectionString $connectionString
}

Initialize-WindowsAuthenticationDatabase -ConnectionString $connectionString

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Application configuration was not found: $ConfigPath"
}

$configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $configuration.PSObject.Properties['ConnectionStrings']) {
    $configuration | Add-Member -MemberType NoteProperty -Name ConnectionStrings -Value ([pscustomobject]@{})
}
if (-not $configuration.ConnectionStrings.PSObject.Properties['DefaultConnection']) {
    $configuration.ConnectionStrings | Add-Member -MemberType NoteProperty -Name DefaultConnection -Value $connectionString
}
else {
    $configuration.ConnectionStrings.DefaultConnection = $connectionString
}

$temporaryPath = "$ConfigPath.tmp"
$configuration | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
Move-Item -LiteralPath $temporaryPath -Destination $ConfigPath -Force
Write-SetupLog -Message "Database configuration updated: $ConfigPath"

$scheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $scheduledTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    Write-SetupLog -Message "Application restarted: $TaskName"
}

if ($interactive) {
    Write-Host ''
    Write-Host 'Configuration completed. Press Enter to close.'
    Read-Host | Out-Null
}
