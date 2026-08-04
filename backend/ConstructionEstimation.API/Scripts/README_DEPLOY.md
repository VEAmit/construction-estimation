# BuildTakeoff Pro — Deployment steps (Member Schedule per-project update)

Give this folder to the client. Two files:

| File | Purpose |
|---|---|
| `Fix_MemberSchedule_ProjectId.sql` | One-time database fix |
| `README_DEPLOY.md` | This file |

---

## Order matters

**Database script first, then deploy the new build.** Running the build first
is not harmful, but the app will log a migration warning until the script runs.

---

## Step 1 — Stop the application

Stop the BuildTakeoff Pro API (or stop the site in IIS).
Do not run the script while the application is running.

## Step 2 — Back up the database

Take a full backup before running the script. The script edits
`MemberScheduleItems` and can rewrite `msi:` links inside `TakeoffItems.Notes`.

```sql
BACKUP DATABASE [ConstructionEstimationDB]
TO DISK = 'C:\Backups\ConstructionEstimationDB_before_fix.bak';
```

## Step 3 — Run the SQL script

**Using SSMS (recommended)**

1. Open `Fix_MemberSchedule_ProjectId.sql`
2. Select the correct database in the dropdown (e.g. `ConstructionEstimationDB`)
3. Execute (F5)

**Using sqlcmd**

```
sqlcmd -S .\SQLEXPRESS2019 -d ConstructionEstimationDB -E -i Fix_MemberSchedule_ProjectId.sql
```

### What a good run looks like

The script prints each step, then a verification table. **All four rows must
say `OK`:**

```
ProjectId column is NOT NULL    OK
DrawingId column is NULL-able   OK
Unique index (ProjectId, Mark)  OK
Migration history row           OK
```

### If it fails

The script runs in a single transaction. On any error it rolls everything back
and prints:

```
FAILED - everything was rolled back.
The database is unchanged. Nothing was half-applied.
```

The database is safe. Send the printed `Error:` line back to us.

The one error that needs a human is:

> Found N member schedule row(s) whose DrawingId matches no drawing

That means orphaned rows exist and no project could be resolved for them.
Do not force it — send us the message.

### Safe to re-run

The script is idempotent. Running it a second time prints
`Migration already applied and schema is complete. Nothing to do.`
It is also safe on a database that never had the column added by hand.

## Step 4 — Deploy the new build

Deploy the new backend and frontend build as usual, then start the application.

## Step 5 — Verify

1. Application starts with **no** `Database migration failed` warning in the log.
2. Open a project with **two or more drawings**.
3. Extract and save a member schedule from drawing A.
4. Extract and save a member schedule from drawing B.
5. **Both drawings' members must still be listed** — B's save must not remove A's.

---

## What this update changes

**Database** — the member schedule becomes project-wide instead of per-drawing:
a `ProjectId` column, a unique `(ProjectId, Mark)` index so the same mark cannot
be duplicated within a project, a foreign key to `Projects`, and `DrawingId`
becomes optional (kept as source metadata).

**Duplicates** — where a project already had the same mark more than once, the
most recently updated row is kept and the others are **soft-deleted**
(`IsDeleted = 1`, not physically removed). Any takeoff item that pointed at a
removed duplicate is re-pointed at the kept row, so no measurement loses its
member link.

**Application fix included in this build** — saving an extracted schedule from
one drawing previously deleted the member schedule rows belonging to *other*
drawings in the same project. That is fixed.

> **Important for existing client data:** if the client has already saved
> schedules from more than one drawing in a project, members were likely
> already lost this way. It failed silently, with no error shown. Those rows
> are still in the database with `IsDeleted = 1` and can be recovered — contact
> us before re-saving, otherwise the recovery is harder to identify later.
>
> Rows lost this way can be listed with:
>
> ```sql
> SELECT ProjectId, DrawingId, Mark, UpdatedAt
> FROM dbo.MemberScheduleItems
> WHERE IsDeleted = 1
> ORDER BY UpdatedAt DESC, ProjectId, DrawingId;
> ```
