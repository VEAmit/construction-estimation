; BuildTakeoff Pro - Windows installer
;
; Build with installer\build.ps1 (it passes AppVersion and the output dir).
; Installs the app as a Windows Service running Kestrel on loopback - no IIS,
; and no .NET runtime prerequisite because the payload is self-contained.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName        "BuildTakeoff Pro"
#define AppPublisher   "Integrated Steel Solutions"
#define ServiceName    "BuildTakeoffPro"
#define ExeName        "ConstructionEstimation.API.exe"
#define DefaultPort    "5000"

[Setup]
AppId={{8F3B1C42-6D77-4A1E-9E4B-2C5A7D9F0B31}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\BuildTakeoff Pro
DefaultGroupName={#AppName}
OutputBaseFilename=BuildTakeoffPro-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
; Service registration, Program Files and SQL provisioning all require elevation.
PrivilegesRequired=admin
DisableDirPage=no
DisableProgramGroupPage=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#ExeName}
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "payload\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "scripts\configure.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "scripts\uninstall.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "scripts\install-sqlexpress.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
; SQL Server Express, ~266 MB. Only extracted when the machine has no SQL
; Server, so installs on machines that already have one cost no extra time.
Source: "prereq\SQLEXPR_x64_ENU.exe"; DestDir: "{tmp}"; \
  Flags: deleteafterinstall; Check: NeedsSqlServer

[Dirs]
; Writable data lives outside Program Files. configure.ps1 sets the ACL.
Name: "{commonappdata}\BuildTakeoffPro"
Name: "{commonappdata}\BuildTakeoffPro\Uploads"
Name: "{commonappdata}\BuildTakeoffPro\Logs"
Name: "{commonappdata}\BuildTakeoffPro\pdfviewer_temp"
Name: "{commonappdata}\BuildTakeoffPro\keys"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{code:GetAppUrl}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{code:GetAppUrl}"; Tasks: desktopicon

[Run]
Filename: "{code:GetAppUrl}"; Description: "Open {#AppName} now"; \
  Flags: shellexec postinstall nowait skipifsilent

[UninstallRun]
; Must stop the service before Inno tries to delete the files it is using.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"" -ServiceName {#ServiceName}"; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[Code]
var
  PortPage: TInputQueryWizardPage;
  SqlPage: TInputQueryWizardPage;

function GetAppUrl(Param: string): string;
begin
  Result := 'http://127.0.0.1:' + PortPage.Values[0] + '/';
end;

{ ---------------------------------------------------------------------------
  Detect any installed SQL Server engine. The app needs one; if none is found
  we tell the user up front rather than failing during configuration.
  --------------------------------------------------------------------------- }
function SqlServerPresent(): Boolean;
var
  Names: TArrayOfString;
begin
  Result := RegGetValueNames(HKLM, 'SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL', Names)
            and (GetArrayLength(Names) > 0);
end;

procedure InitializeWizard();
begin
  PortPage := CreateInputQueryPage(wpSelectTasks,
    'Network port',
    'Which port should BuildTakeoff Pro listen on?',
    'The application runs locally and is reached through your browser. ' +
    'Change this only if another program already uses the port.');
  PortPage.Add('Port:', False);
  PortPage.Values[0] := '{#DefaultPort}';

  SqlPage := CreateInputQueryPage(PortPage.ID,
    'SQL Server',
    'Which SQL Server instance should be used?',
    'BuildTakeoff Pro stores its data in SQL Server. Leave the default if ' +
    'SQL Server Express was installed with its usual settings.');
  SqlPage.Add('Instance:', False);
  SqlPage.Values[0] := '.\SQLEXPRESS';
end;

{ When no SQL Server exists we install our own SQLEXPRESS instance, so asking
  the user to name one would be meaningless. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = SqlPage.ID) and (not SqlServerPresent());
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;

  if CurPageID = PortPage.ID then
  begin
    Port := StrToIntDef(PortPage.Values[0], -1);
    { Below 1024 is reserved and would need extra privileges; above 65535 is invalid. }
    if (Port < 1024) or (Port > 65535) then
    begin
      MsgBox('Please enter a port number between 1024 and 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;

  if (CurPageID = SqlPage.ID) and (Trim(SqlPage.Values[0]) = '') then
  begin
    MsgBox('Please enter a SQL Server instance name.', mbError, MB_OK);
    Result := False;
  end;
end;

{ Used by [Files] so the 266 MB SQL Express payload is only unpacked when the
  machine actually needs it. }
function NeedsSqlServer(): Boolean;
begin
  Result := not SqlServerPresent();
end;

{ ---------------------------------------------------------------------------
  Run configure.ps1 after files are copied: data dirs + ACL, appsettings,
  database provisioning, service registration, health check.
  --------------------------------------------------------------------------- }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: string;
  LogPath: string;
begin
  if CurStep <> ssPostInstall then
    Exit;

  { SQL Server Express first - configure.ps1 cannot create the database without
    it. Skipped entirely when an instance already exists. }
  if NeedsSqlServer() then
  begin
    WizardForm.StatusLabel.Caption := 'Installing SQL Server Express. This can take several minutes...';

    Params :=
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\install-sqlexpress.ps1') + '"' +
      ' -SetupExe "' + ExpandConstant('{tmp}\SQLEXPR_x64_ENU.exe') + '"' +
      ' -InstanceName SQLEXPRESS';

    if (not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode))
       or (ResultCode <> 0) then
    begin
      MsgBox('SQL Server Express could not be installed automatically.' + #13#10#13#10 +
             'BuildTakeoff Pro needs a database to run. Install SQL Server Express ' +
             'manually, then re-run this installer.' + #13#10#13#10 +
             'Setup log: C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt',
             mbCriticalError, MB_OK);
      Exit;
    end;

    { The freshly created instance is always named SQLEXPRESS, whatever the
      user typed on the earlier page for a pre-existing server. }
    SqlPage.Values[0] := '.\SQLEXPRESS';
  end;

  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\configure.ps1') + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"' +
    ' -DataDir "'    + ExpandConstant('{commonappdata}\BuildTakeoffPro') + '"' +
    ' -Port '        + PortPage.Values[0] +
    ' -SqlInstance "' + SqlPage.Values[0] + '"' +
    ' -ServiceName ' + '{#ServiceName}';

  WizardForm.StatusLabel.Caption := 'Configuring database and service. This may take a minute...';

  if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Could not run the configuration step.' + #13#10 +
           'Error: ' + SysErrorMessage(ResultCode), mbCriticalError, MB_OK);
    Exit;
  end;

  if ResultCode <> 0 then
  begin
    LogPath := ExpandConstant('{commonappdata}\BuildTakeoffPro\Logs');
    MsgBox('BuildTakeoff Pro was installed but could not be started automatically.' + #13#10#13#10 +
           'This usually means SQL Server is not reachable at the instance you entered, ' +
           'or the chosen port is already in use.' + #13#10#13#10 +
           'Check the log files in:' + #13#10 + LogPath + #13#10#13#10 +
           'You can re-run the configuration at any time from:' + #13#10 +
           ExpandConstant('{app}\scripts\configure.ps1'),
           mbError, MB_OK);
  end;
end;

{ ---------------------------------------------------------------------------
  Uninstall: the data directory holds the customer's uploaded drawings, so it
  is kept unless they explicitly say otherwise. The database is never touched.
  --------------------------------------------------------------------------- }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;

  DataDir := ExpandConstant('{commonappdata}\BuildTakeoffPro');
  if not DirExists(DataDir) then
    Exit;

  if MsgBox('Remove uploaded drawings and application data?' + #13#10#13#10 +
            DataDir + #13#10#13#10 +
            'Choose No to keep them for a future reinstall.' + #13#10 +
            'The database is not removed either way.',
            mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(DataDir, True, True, True);
end;
