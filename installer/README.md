# BuildTakeoff Pro installer

This folder contains the only installer mechanism for the project. It packages
a Windows x64 self-contained ASP.NET Core publish (including the React bundle
copied to `wwwroot`) and runs it locally through Kestrel. The application is
registered as a Windows startup task under the built-in SYSTEM identity. IIS,
the ASP.NET Core Hosting Bundle, and a separately installed .NET runtime are not
required. Frontend and `/api` requests stay on the same local origin.

Generated content is intentionally not committed:

- `staging/App/` - validated `dotnet publish` output used as installer input.
- `Output/` - versioned final installer EXEs; previous versions are preserved.

The repository-level `publish/` and frontend `dist/` folders remain compatible
with the existing build commands. The installer does not consume, delete, or
restructure those folders.

## Build-machine prerequisites

1. Windows 10/11 or Windows Server (x64).
2. .NET 8 SDK.
3. Node.js/npm with the repository dependencies installed.
4. Inno Setup 6 (`ISCC.exe`). Install once with:

   ```powershell
   winget install --id JRSoftware.InnoSetup -e
   ```

## Create the installer

From the repository root:

```powershell
npm install
npm --prefix frontend install
npm run build:installer
```

The last command safely cleans only `installer/staging` and `installer/Output`,
runs the existing backend publish (which also builds/copies the current React
bundle), removes the developer-machine connection from the staged base config,
validates required runtime/OCR/frontend files, and compiles Inno Setup.

Final output:

```text
installer\Output\BuildTakeoffPro-Setup-5.8.9.1.exe
```

To use a non-default Inno compiler location:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\Build-Installer.ps1 `
  -InnoCompiler "D:\Tools\Inno Setup 6\ISCC.exe"
```

## Target-machine prerequisites

The target needs Windows 10/11 or Windows Server x64 and access to SQL Server.
It does **not** need IIS, the ASP.NET Core Hosting Bundle, or the .NET runtime.

- SQL Server authentication works with local or remote SQL Server when the SQL
  login can create/migrate the selected database.
- Windows authentication works automatically with SQL Server installed on the
  same computer. Setup creates the database when needed and grants the local
  application identity (`LocalSystem`) access. Run setup with a Windows account
  that has permission to create a database and Windows login in SQL Server.
- For remote SQL Server, use SQL Server authentication. This avoids storing a
  domain account password in Windows Task Scheduler.

## Installer database behavior

The setup wizard asks for:

- SQL Server name/address.
- Database name.
- Windows or SQL Server authentication.
- SQL user and password when SQL authentication is selected.
- Local HTTP port.

The SQL Server field is an editable dropdown. Setup discovers installed local
Database Engine instances (for example `.` and `.\SQLEXPRESS`) and lists them
automatically. If a generic local address such as `localhost` is entered, setup
tries the default instance first and then detected named instances. Only
server/instance-not-found failures trigger this fallback; invalid SQL passwords
or permission errors remain attached to the explicitly selected instance.

The build never packages the developer's SQL connection. Setup tests the server
credentials and writes the generated connection to:

```text
<install folder>\App\appsettings.Production.json
```

Existing production settings, including licensing configuration, are preserved.
The API continues using `GetConnectionString("DefaultConnection")` and runs the
existing EF Core migrations during startup. Installer builds also configure the
ASP.NET Core Data Protection key ring under
`App_Data\DataProtection-Keys`, so an encrypted saved license remains readable
after application or Windows restarts.

If the external license provider is temporarily unavailable during first-time
validation, the entered key is retained in encrypted form with a non-valid retry
status. Login remains blocked, but the administrator can retry without entering
the key again and application startup will validate it again automatically.
Definitively invalid, expired, revoked or unknown keys are not saved.

To change the database later, use Start Menu:

```text
BuildTakeoff Pro > Update Database Configuration
```

The utility validates the new SQL connection, updates only
`DefaultConnection`, configures local Windows-authentication permissions when
selected, and restarts the standalone application task.

## Clean-machine verification

1. Use a Windows VM/snapshot that does not have BuildTakeoff Pro installed.
2. Confirm IIS, the Hosting Bundle and .NET are not required by using a clean VM
   that does not contain them.
3. Ensure the test SQL Server permits the selected credentials and firewall
   access. The login must be able to create/migrate the target database, or the
   empty database must already exist with suitable permissions.
4. Run `BuildTakeoffPro-Setup-5.8.9.1.exe` as Administrator. When upgrading
   an existing installation, setup stops its scheduled task and any remaining
   child API process before replacing application files; uninstalling the old
   version first is not required.
5. Test once with SQL Server authentication and once with Windows
   authentication against a local SQL Server, using separate empty databases.
6. Choose an available port such as `8080` and finish setup.
7. Open `http://127.0.0.1:8080/`, configure/validate the license, then log in.
8. Create a project, upload a PDF larger than 30 MB, extract a member schedule,
   create/edit/delete a measurement, and verify export.
9. Restart Windows and confirm the application starts automatically and existing
    database/license/upload data remains available.
10. Run **Update Database Configuration**, point to another test database, and
    confirm the application starts against the updated connection.
11. Uninstall from Apps & Features and confirm the `BuildTakeoffPro` scheduled
    task is removed. Runtime-created data folders are not explicitly force-deleted.

## Existing-output audit

No `.iss`, WiX, Visual Studio Installer, NSIS, or installer project existed in
the audited branch. No source file references an `Output` directory. The old
`D:\Output` screenshot contains unrelated external installer executables and is
outside this repository; this implementation does not modify or delete it.
