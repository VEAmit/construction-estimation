#define MyAppName "BuildTakeoff Pro"
#define MyAppPublisher "BuildTakeoff Pro"
#define MyTaskName "BuildTakeoffPro"
#ifndef MyAppVersion
  #define MyAppVersion "5.8.9.1"
#endif

[Setup]
AppId={{9A74EA3A-26DA-4B85-A2BE-523406321541}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\BuildTakeoff Pro
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=CompilerOutput
OutputBaseFilename=BuildTakeoffPro-Setup-{#MyAppVersion}
SetupIconFile=..\frontend\public\favicon 1.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
UninstallDisplayIcon={app}\App\wwwroot\favicon 1.ico
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}

[Files]
Source: "staging\App\*"; DestDir: "{app}\App"; Excludes: "appsettings.Development.json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "scripts\Configure-Database.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "scripts\Install-StandaloneTask.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "scripts\Remove-StandaloneTask.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "scripts\Start-Application.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "scripts\Stop-StandaloneApplication.ps1"; Flags: dontcopy

[Dirs]
Name: "{app}\App\Uploads"
Name: "{app}\App\Logs"
Name: "{app}\App\App_Data\DataProtection-Keys"
Name: "{app}\InstallerLogs"

[Icons]
Name: "{group}\Open BuildTakeoff Pro"; Filename: "http://127.0.0.1:{code:GetApplicationPort}/"; IconFilename: "{app}\App\wwwroot\favicon 1.ico"
Name: "{group}\Update Database Configuration"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\Configure-Database.ps1"" -ConfigPath ""{app}\App\appsettings.Production.json"" -TaskName ""{#MyTaskName}"" -LogPath ""{app}\InstallerLogs\DatabaseSetup.log"""; WorkingDir: "{app}\Tools"; IconFilename: "{app}\App\wwwroot\favicon 1.ico"
Name: "{autodesktop}\BuildTakeoff Pro"; Filename: "http://127.0.0.1:{code:GetApplicationPort}/"; Tasks: desktopicon; IconFilename: "{app}\App\wwwroot\favicon 1.ico"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Registry]
Root: HKLM; Subkey: "Software\BuildTakeoffPro"; ValueType: string; ValueName: "ApplicationTaskName"; ValueData: "{#MyTaskName}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\BuildTakeoffPro"; ValueType: string; ValueName: "ApplicationPort"; ValueData: "{code:GetApplicationPort}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\BuildTakeoffPro"; ValueType: none; ValueName: "IisSiteName"; Flags: deletevalue
Root: HKLM; Subkey: "Software\BuildTakeoffPro"; ValueType: none; ValueName: "IisAppPoolName"; Flags: deletevalue
Root: HKLM; Subkey: "Software\BuildTakeoffPro"; ValueType: none; ValueName: "IisPort"; Flags: deletevalue

[Run]
Filename: "http://127.0.0.1:{code:GetApplicationPort}/"; Description: "Open BuildTakeoff Pro"; Flags: shellexec postinstall skipifsilent nowait

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\Remove-StandaloneTask.ps1"" -TaskName ""{reg:HKLM\Software\BuildTakeoffPro,ApplicationTaskName|{#MyTaskName}}"" -ApplicationPath ""{app}\App\ConstructionEstimation.API.exe"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveBuildTakeoffProStandaloneTask"

[Code]
var
  DatabasePage: TWizardPage;
  DatabaseServerLabel: TNewStaticText;
  DatabaseServerEdit: TNewComboBox;
  DatabaseNameLabel: TNewStaticText;
  DatabaseNameEdit: TNewEdit;
  WindowsAuthRadio: TNewRadioButton;
  SqlAuthRadio: TNewRadioButton;
  WindowsAuthHelp: TNewStaticText;
  SqlUserLabel: TNewStaticText;
  SqlUserEdit: TNewEdit;
  SqlPasswordLabel: TNewStaticText;
  SqlPasswordEdit: TNewEdit;
  ApplicationPage: TInputQueryWizardPage;
  LegacyIisSiteName: string;

function QuoteArgument(const Value: string): string;
begin
  Result := Value;
  StringChangeEx(Result, '"', '\"', True);
  Result := '"' + Result + '"';
end;

function JsonEscape(const Value: string): string;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
  StringChangeEx(Result, #13, '\r', True);
  StringChangeEx(Result, #10, '\n', True);
end;

function QuoteConnectionValue(const Value: string): string;
begin
  Result := Value;
  StringChangeEx(Result, '"', '""', True);
  Result := '"' + Result + '"';
end;

function SqlServerChoiceExists(const Value: string): Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 0 to DatabaseServerEdit.Items.Count - 1 do
  begin
    if CompareText(DatabaseServerEdit.Items[Index], Value) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddSqlServerChoice(const Value: string);
begin
  if (Trim(Value) <> '') and (not SqlServerChoiceExists(Value)) then
    DatabaseServerEdit.Items.Add(Value);
end;

procedure AddSqlServerChoicesFromRegistry(const SubkeyName: string);
var
  InstanceNames: TArrayOfString;
  Index: Integer;
  InstanceName: string;
begin
  if RegGetValueNames(HKEY_LOCAL_MACHINE, SubkeyName, InstanceNames) then
  begin
    for Index := 0 to GetArrayLength(InstanceNames) - 1 do
    begin
      InstanceName := InstanceNames[Index];
      if CompareText(InstanceName, 'MSSQLSERVER') = 0 then
        AddSqlServerChoice('.')
      else
        AddSqlServerChoice('.\' + InstanceName);
    end;
  end;
end;

procedure PopulateLocalSqlServerChoices;
begin
  AddSqlServerChoicesFromRegistry(
    'SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL');
  AddSqlServerChoicesFromRegistry(
    'SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL');
end;

function IsLocalSqlServer(const Value: string): Boolean;
var
  ServerValue: string;
  SeparatorPosition: Integer;
begin
  ServerValue := Lowercase(Trim(Value));
  if Pos('tcp:', ServerValue) = 1 then
    Delete(ServerValue, 1, 4);

  if Pos('(localdb)', ServerValue) = 1 then
  begin
    Result := False;
    Exit;
  end;

  SeparatorPosition := Pos('\', ServerValue);
  if SeparatorPosition > 0 then
    ServerValue := Copy(ServerValue, 1, SeparatorPosition - 1);
  SeparatorPosition := Pos(',', ServerValue);
  if SeparatorPosition > 0 then
    ServerValue := Copy(ServerValue, 1, SeparatorPosition - 1);

  Result :=
    (ServerValue = '.') or
    (ServerValue = '(local)') or
    (ServerValue = 'localhost') or
    (ServerValue = '127.0.0.1') or
    (ServerValue = '::1') or
    (CompareText(ServerValue, GetComputerNameString()) = 0);
end;

procedure UpdateAuthenticationFields(Sender: TObject);
begin
  SqlUserEdit.Enabled := SqlAuthRadio.Checked;
  SqlPasswordEdit.Enabled := SqlAuthRadio.Checked;
  SqlUserLabel.Enabled := SqlAuthRadio.Checked;
  SqlPasswordLabel.Enabled := SqlAuthRadio.Checked;
  WindowsAuthHelp.Visible := WindowsAuthRadio.Checked;
end;

procedure InitializeWizard;
begin
  DatabasePage := CreateCustomPage(
    wpSelectDir,
    'Database configuration',
    'Enter the SQL Server connection used by BuildTakeoff Pro. No database value is hardcoded into the installer.');

  DatabaseServerLabel := TNewStaticText.Create(DatabasePage);
  DatabaseServerLabel.Parent := DatabasePage.Surface;
  DatabaseServerLabel.Caption := 'SQL Server name or address:';
  DatabaseServerLabel.Left := 0;
  DatabaseServerLabel.Top := 8;

  DatabaseServerEdit := TNewComboBox.Create(DatabasePage);
  DatabaseServerEdit.Parent := DatabasePage.Surface;
  DatabaseServerEdit.Left := 0;
  DatabaseServerEdit.Top := 28;
  DatabaseServerEdit.Width := DatabasePage.SurfaceWidth;
  DatabaseServerEdit.Style := csDropDown;
  PopulateLocalSqlServerChoices();
  if DatabaseServerEdit.Items.Count > 0 then
    DatabaseServerEdit.Text := GetPreviousData(
      'DatabaseServer', DatabaseServerEdit.Items[0])
  else
    DatabaseServerEdit.Text := GetPreviousData('DatabaseServer', 'localhost');

  DatabaseNameLabel := TNewStaticText.Create(DatabasePage);
  DatabaseNameLabel.Parent := DatabasePage.Surface;
  DatabaseNameLabel.Caption := 'Database name:';
  DatabaseNameLabel.Left := 0;
  DatabaseNameLabel.Top := 66;

  DatabaseNameEdit := TNewEdit.Create(DatabasePage);
  DatabaseNameEdit.Parent := DatabasePage.Surface;
  DatabaseNameEdit.Left := 0;
  DatabaseNameEdit.Top := 86;
  DatabaseNameEdit.Width := DatabasePage.SurfaceWidth;
  DatabaseNameEdit.Text := GetPreviousData('DatabaseName', 'ConstructionEstimationDB');

  WindowsAuthRadio := TNewRadioButton.Create(DatabasePage);
  WindowsAuthRadio.Parent := DatabasePage.Surface;
  WindowsAuthRadio.Caption := 'Windows authentication (local SQL Server)';
  WindowsAuthRadio.Left := 0;
  WindowsAuthRadio.Top := 126;
  WindowsAuthRadio.OnClick := @UpdateAuthenticationFields;

  SqlAuthRadio := TNewRadioButton.Create(DatabasePage);
  SqlAuthRadio.Parent := DatabasePage.Surface;
  SqlAuthRadio.Caption := 'SQL Server authentication';
  SqlAuthRadio.Left := 245;
  SqlAuthRadio.Top := 126;
  SqlAuthRadio.Checked := True;
  SqlAuthRadio.OnClick := @UpdateAuthenticationFields;

  WindowsAuthHelp := TNewStaticText.Create(DatabasePage);
  WindowsAuthHelp.Parent := DatabasePage.Surface;
  WindowsAuthHelp.Caption := 'The installer grants the local application identity access automatically. Use SQL authentication for a remote SQL Server.';
  WindowsAuthHelp.Left := 0;
  WindowsAuthHelp.Top := 148;
  WindowsAuthHelp.Width := DatabasePage.SurfaceWidth;
  WindowsAuthHelp.WordWrap := True;
  WindowsAuthHelp.Font.Color := clGray;

  SqlUserLabel := TNewStaticText.Create(DatabasePage);
  SqlUserLabel.Parent := DatabasePage.Surface;
  SqlUserLabel.Caption := 'SQL user name:';
  SqlUserLabel.Left := 0;
  SqlUserLabel.Top := 178;

  SqlUserEdit := TNewEdit.Create(DatabasePage);
  SqlUserEdit.Parent := DatabasePage.Surface;
  SqlUserEdit.Left := 0;
  SqlUserEdit.Top := 198;
  SqlUserEdit.Width := DatabasePage.SurfaceWidth;
  SqlUserEdit.Text := GetPreviousData('DatabaseUser', 'sa');

  SqlPasswordLabel := TNewStaticText.Create(DatabasePage);
  SqlPasswordLabel.Parent := DatabasePage.Surface;
  SqlPasswordLabel.Caption := 'SQL password:';
  SqlPasswordLabel.Left := 0;
  SqlPasswordLabel.Top := 232;

  SqlPasswordEdit := TNewEdit.Create(DatabasePage);
  SqlPasswordEdit.Parent := DatabasePage.Surface;
  SqlPasswordEdit.Left := 0;
  SqlPasswordEdit.Top := 252;
  SqlPasswordEdit.Width := DatabasePage.SurfaceWidth;
  SqlPasswordEdit.PasswordChar := '*';

  LegacyIisSiteName := GetPreviousData('IisSiteName', 'BuildTakeoffPro');
  ApplicationPage := CreateInputQueryPage(
    DatabasePage.ID,
    'Local application address',
    'Choose the local HTTP port used to open BuildTakeoff Pro.',
    'The application is self-contained and starts automatically with Windows. IIS and the ASP.NET Core Hosting Bundle are not required.');
  ApplicationPage.Add('HTTP port:', False);
  ApplicationPage.Values[0] := GetPreviousData(
    'ApplicationPort', GetPreviousData('IisPort', '8080'));

  UpdateAuthenticationFields(nil);
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'DatabaseServer', Trim(DatabaseServerEdit.Text));
  SetPreviousData(PreviousDataKey, 'DatabaseName', Trim(DatabaseNameEdit.Text));
  SetPreviousData(PreviousDataKey, 'DatabaseUser', Trim(SqlUserEdit.Text));
  SetPreviousData(PreviousDataKey, 'ApplicationPort', Trim(ApplicationPage.Values[0]));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortValue: Integer;
begin
  Result := False;
  if CurPageID = DatabasePage.ID then
  begin
    if Trim(DatabaseServerEdit.Text) = '' then
    begin
      MsgBox('Enter the SQL Server name or address.', mbError, MB_OK);
      Exit;
    end;
    if Trim(DatabaseNameEdit.Text) = '' then
    begin
      MsgBox('Enter the database name.', mbError, MB_OK);
      Exit;
    end;
    if WindowsAuthRadio.Checked and (not IsLocalSqlServer(DatabaseServerEdit.Text)) then
    begin
      MsgBox(
        'Automatic Windows authentication is supported for SQL Server installed on this computer. ' +
        'For a remote SQL Server, select SQL Server authentication.',
        mbError, MB_OK);
      Exit;
    end;
    if SqlAuthRadio.Checked and (Trim(SqlUserEdit.Text) = '') then
    begin
      MsgBox('Enter the SQL user name.', mbError, MB_OK);
      Exit;
    end;
    if SqlAuthRadio.Checked and (SqlPasswordEdit.Text = '') then
    begin
      MsgBox('Enter the SQL password.', mbError, MB_OK);
      Exit;
    end;
  end;

  if CurPageID = ApplicationPage.ID then
  begin
    PortValue := StrToIntDef(Trim(ApplicationPage.Values[0]), 0);
    if (PortValue < 1) or (PortValue > 65535) then
    begin
      MsgBox('Enter a valid HTTP port between 1 and 65535.', mbError, MB_OK);
      Exit;
    end;
  end;

  Result := True;
end;

function GetApplicationPort(Param: string): string;
begin
  Result := Trim(ApplicationPage.Values[0]);
end;

function BuildConnectionString: string;
begin
  Result :=
    'Server=' + QuoteConnectionValue(Trim(DatabaseServerEdit.Text)) +
    ';Database=' + QuoteConnectionValue(Trim(DatabaseNameEdit.Text)) +
    ';MultipleActiveResultSets=True;TrustServerCertificate=True;Encrypt=False';
  if WindowsAuthRadio.Checked then
    Result := Result + ';Trusted_Connection=True'
  else
    Result := Result +
      ';User Id=' + QuoteConnectionValue(Trim(SqlUserEdit.Text)) +
      ';Password=' + QuoteConnectionValue(SqlPasswordEdit.Text);
end;

procedure StopExistingHosting;
var
  ResultCode: Integer;
  TaskSchedulerPath: string;
  AppCmdPath: string;
begin
  TaskSchedulerPath := ExpandConstant('{sys}\schtasks.exe');
  if FileExists(TaskSchedulerPath) then
  begin
    Exec(TaskSchedulerPath, '/End /TN ' + QuoteArgument('{#MyTaskName}'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(TaskSchedulerPath, '/Delete /F /TN ' + QuoteArgument('{#MyTaskName}'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  { Upgrade cleanup for installer versions that hosted the same application in IIS. }
  AppCmdPath := ExpandConstant('{sys}\inetsrv\appcmd.exe');
  if FileExists(AppCmdPath) and (Trim(LegacyIisSiteName) <> '') then
  begin
    Exec(AppCmdPath, 'stop site /site.name:' + QuoteArgument(LegacyIisSiteName), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(AppCmdPath, 'stop apppool /apppool.name:' + QuoteArgument(LegacyIisSiteName), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PowerShellPath: string;
  StopScriptPath: string;
  Parameters: string;
  ResultCode: Integer;
  Executed: Boolean;
begin
  Result := '';
  StopExistingHosting();

  ExtractTemporaryFile('Stop-StandaloneApplication.ps1');
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  StopScriptPath := ExpandConstant('{tmp}\Stop-StandaloneApplication.ps1');
  Parameters :=
    '-NoProfile -ExecutionPolicy Bypass -File ' + QuoteArgument(StopScriptPath) +
    ' -TaskName ' + QuoteArgument('{#MyTaskName}') +
    ' -ApplicationPath ' + QuoteArgument(ExpandConstant('{app}\App\ConstructionEstimation.API.exe')) +
    ' -LogPath ' + QuoteArgument(ExpandConstant('{tmp}\BuildTakeoffPro.Upgrade.log'));
  Executed := Exec(
    PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if (not Executed) or (ResultCode <> 0) then
    Result :=
      'The existing BuildTakeoff Pro application could not be stopped. ' +
      'Close any running BuildTakeoff Pro window and try again. ' +
      'Setup log: ' + ExpandConstant('{tmp}\BuildTakeoffPro.Upgrade.log');
end;

procedure ConfigureInstalledApplication;
var
  ConnectionString: string;
  SettingsJson: string;
  SettingsPath: string;
  PowerShellPath: string;
  ConfigureScript: string;
  StandaloneScript: string;
  Parameters: string;
  ResultCode: Integer;
  Executed: Boolean;
begin
  ConnectionString := BuildConnectionString();
  SettingsJson :=
    '{' + #13#10 +
    '  "ConnectionStrings": {' + #13#10 +
    '    "DefaultConnection": "' + JsonEscape(ConnectionString) + '"' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10;
  SettingsPath := ExpandConstant('{tmp}\BuildTakeoffPro.Database.json');
  if not SaveStringToFile(SettingsPath, SettingsJson, False) then
    RaiseException('Could not create the temporary database configuration.');

  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ConfigureScript := ExpandConstant('{app}\Tools\Configure-Database.ps1');
  Parameters :=
    '-NoProfile -ExecutionPolicy Bypass -File ' + QuoteArgument(ConfigureScript) +
    ' -ConfigPath ' + QuoteArgument(ExpandConstant('{app}\App\appsettings.Production.json')) +
    ' -SettingsFile ' + QuoteArgument(SettingsPath) +
    ' -TaskName ' + QuoteArgument('{#MyTaskName}') +
    ' -LogPath ' + QuoteArgument(ExpandConstant('{app}\InstallerLogs\DatabaseSetup.log'));
  Executed := Exec(PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  DeleteFile(SettingsPath);
  if (not Executed) or (ResultCode <> 0) then
    RaiseException(
      'Database setup failed. Check the SQL Server details and permissions. ' +
      'Windows authentication requires a local SQL Server and an installer user allowed to create the database. ' +
      'Details: ' + ExpandConstant('{app}\InstallerLogs\DatabaseSetup.log'));

  StandaloneScript := ExpandConstant('{app}\Tools\Install-StandaloneTask.ps1');
  Parameters :=
    '-NoProfile -ExecutionPolicy Bypass -File ' + QuoteArgument(StandaloneScript) +
    ' -TaskName ' + QuoteArgument('{#MyTaskName}') +
    ' -ApplicationPath ' + QuoteArgument(ExpandConstant('{app}\App\ConstructionEstimation.API.exe')) +
    ' -Port ' + GetApplicationPort('') +
    ' -LegacyIisSiteName ' + QuoteArgument(LegacyIisSiteName) +
    ' -LogPath ' + QuoteArgument(ExpandConstant('{app}\InstallerLogs\ApplicationSetup.log'));
  Executed := Exec(PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if (not Executed) or (ResultCode <> 0) then
    RaiseException(
      'The local application could not be started. Check that the selected port is available. ' +
      'Details: ' + ExpandConstant('{app}\InstallerLogs\ApplicationSetup.log'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    ConfigureInstalledApplication();
end;
