# Oracle backup and restore verification

These scripts make a recoverable snapshot of the Oracle Windows Wine & Larder OS deployment and test it in **a newly named PostgreSQL database and directory**. They never restore into, drop, or stop the production `openmuse` database or service. An isolated restore was verified on 23 September 2026; no restore into production has been run.

## Coverage

| Source | Backup location | Proof during verification |
| --- | --- | --- |
| PostgreSQL `openmuse` on port `5433` | `openmuse.dump`, custom format | `pg_restore` into new `openmuse_verify_*` database; sorted content SHA256 of every `records` row; counts by every record kind |
| Tasks, run events, chat threads/messages/runs, memories, business connections/facts/syncs, file metadata | Inside the database dump | Separate per-kind SHA256 and counts; all kinds are also covered by the full record digest |
| `C:\OpenMuseBusinessOS\data\app` | `recovery/data/app` | SHA256 of every copied file and a second SHA256 after copying to the isolated verification directory; each database PDF record must have its PDF |
| `C:\OpenMuseBusinessOS\app\.env` | `recovery/app/.env` | SHA256 before and after isolated copy; **not executed** during verification |
| `C:\OpenMuseBusinessOS\secrets`, including `pg-admin-password` | `recovery/secrets` | SHA256 before and after isolated copy; **not displayed** |
| Explicit extra recovery paths, including the isolated Hermes home and workspace | `recovery/extra/*` | SHA256 before and after isolated copy; original paths recorded in protected manifest |

Hermes profiles, its own workspace, and any computer-use artifacts outside `data\app` are **not discovered automatically**. Pass each such directory through `-AdditionalRecoveryPaths` after identifying its real path. The manifest lists each explicit extra path, so an omitted path remains a visible coverage gap. The same applies to provider private keys outside `secrets`.

The live PostgreSQL cluster at `C:\OpenMuseBusinessOS\data\postgres` is explicitly excluded from the file copy. It is backed up through `pg_dump`, not by copying an active cluster. The script refuses an extra path inside or above that cluster. The app data directory is `data\app`; it includes the session-signing key and uploaded PDFs. The deployed application build and Windows service definitions should be retained as release/configuration artifacts separately; this is a persistent-state backup.

## Run a backup on Oracle

Run PowerShell as the account allowed to read the app data and secrets, and use the deployed `openmuse_admin` PostgreSQL role. The scripts use the portable PostgreSQL tools at `C:\OpenMuseBusinessOS\runtime\pgsql\bin`. Supply authentication through `PGPASSWORD` or a private `PGPASSFILE`; the scripts do not print the password. Choose a dedicated destination on encrypted storage outside the live data directory. The new timestamped backup folder gets ACLs limited to the running account, SYSTEM, and Administrators. Do not publish or sync that folder to an untrusted service: it contains `.env`, the PostgreSQL recovery password, and provider secrets.

Before running the backup, quiesce all OpenMuse, Hermes, and other processes that write this database or `data\app`. The script requires the explicit `-WritesQuiesced` switch and compares a full record digest before and after the dump and file copy. A changed digest marks the backup incomplete. This is an operational prerequisite: the switch alone cannot stop an external writer.

```powershell
$env:PGPASSWORD = [IO.File]::ReadAllText('C:\OpenMuseBusinessOS\secrets\pg-admin-password').Trim()
try {
  & 'C:\OpenMuseBusinessOS\app\scripts\backup\backup.ps1' `
    -Destination 'E:\OpenMuseBackups' -WritesQuiesced
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

Add `-AdditionalRecoveryPaths @('C:\actual\HermesProfile', 'C:\actual\revolut-private-key.pem')` when those paths exist outside `data\app` and `secrets`. Do not use `C:\OpenMuseBusinessOS\data` as an extra path because that contains the live PostgreSQL cluster. If a file referenced in the database is missing from the copy, the script marks the backup incomplete instead of claiming success. A folder containing `.incomplete` is unusable for recovery.

The output folder contains `manifest.json`, `manifest.sha256`, `openmuse.dump`, and `recovery/`. The manifest records file lengths and SHA256 hashes, a full database-record digest, every kind's count, and separate important-kind digests. The manifest hash detects accidental changes; it is not a cryptographic signature against a person who can rewrite the whole backup. Keep the entire folder and at least one independently stored encrypted copy.

## Prove a restore without touching production

Use the same PostgreSQL 17 tools and a role allowed to create a database. The verification script first checks every backup hash, then creates a random `openmuse_verify_*` database. It restores the dump there, recomputes every record count and content digest, copies recovery files into a new ACL-protected folder, rehashes every file, and checks all PDF record references. It retains the verification database and folder for inspection. It never copies recovery secrets back to their original live paths or executes `.env`.

```powershell
$env:PGPASSWORD = [IO.File]::ReadAllText('C:\OpenMuseBusinessOS\secrets\pg-admin-password').Trim()
try {
  & 'C:\OpenMuseBusinessOS\app\scripts\backup\verify-restore.ps1' `
    -BackupDirectory 'E:\OpenMuseBackups\openmuse-YYYYMMDDTHHMMSSZ-XXXXXXXX'
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

Success prints `RESTORE VERIFIED` with the exact temporary database name and a protected `verification-report.json` path under `C:\OpenMuseBusinessOS\restore-verification`. Inspect the report: `status` must be `verified`, `productionDatabaseTouched` must be `false`, the full digest and important-kind digests must match, and the expected tasks, conversations, memories, business records, and PDFs must be counted. A failure leaves the temporary database and report in place for diagnosis; it does not fall back to production. Clean up that test database only after reviewing the result, using an explicit operator action. Do not describe a backup as proven until this command succeeds against it.

## Verified Oracle acceptance and limits

On 23 September 2026, the isolated OpenMuse API and Hermes writers were stopped, their ports were confirmed closed, and PostgreSQL remained online. The protected snapshot included the app data, private app environment, deployment secrets, isolated Hermes home, and isolated workspace. The script restored the custom dump into a new `openmuse_verify_*` database, compared the complete `records` digest and every kind count, checked important task/chat/memory/business/file kinds separately, verified all copied recovery files, and matched the uploaded acceptance PDF's SHA256 in both the backup and restored copy. The API and Hermes scheduled tasks were restarted in the runner's `finally` block, and both services and PostgreSQL passed health checks. Exact host paths, counts, hashes, and the verification report location are retained in the ignored local `artifacts/backup-acceptance.json` and the ACL-protected Oracle report. Two earlier runs exposed a Windows `pg_dump` file-ACL issue and remain marked `.incomplete`; the script was corrected and neither folder is a valid backup.

This proves the captured database records and selected files can be restored consistently into an isolated test database. It does **not** prove an application startup against that restored database, a production disaster restore, recovery of PostgreSQL cluster-wide roles/permissions, Windows scheduled-task definitions, installed runtimes, or unrelated Oracle/user services. `pg_dump --no-owner --no-acl` intentionally excludes original ownership and grants. The live PostgreSQL cluster is never copied. The tested backup and verification copy are on the same Oracle machine; there is no verified off-machine encrypted copy yet, so machine loss remains uncovered. Provider accounts and tokens were not re-authorized during this restore test. Future backups need fresh quiescence and a new isolated restore check before being described as verified.
