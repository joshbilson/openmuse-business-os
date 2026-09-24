param(
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [string]$VerificationRoot = 'C:\OpenMuseBusinessOS\restore-verification',
  [string]$PgBin = 'C:\OpenMuseBusinessOS\runtime\pgsql\bin',
  [string]$PgHost = '127.0.0.1',
  [int]$PgPort = 5433,
  [string]$PgUser = 'openmuse_admin'
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Windows
$pgRestore = Join-Path $PgBin 'pg_restore.exe'
$psql = Join-Path $PgBin 'psql.exe'
$createdb = Join-Path $PgBin 'createdb.exe'
foreach ($tool in @($pgRestore, $psql, $createdb)) { Assert-Tool $tool }
$backup = [IO.Path]::GetFullPath($BackupDirectory)
if (-not (Test-Path -LiteralPath $backup -PathType Container)) { throw "Backup directory is missing: $backup" }
if (Test-Path -LiteralPath (Join-Path $backup '.incomplete')) { throw 'Backup is marked incomplete.' }
Assert-NoReparsePoints $backup
$manifestPath = Join-Path $backup 'manifest.json'
$manifestHashPath = Join-Path $backup 'manifest.sha256'
foreach ($path in @($manifestPath, $manifestHashPath, (Join-Path $backup 'openmuse.dump'))) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Backup component is missing: $path" }
}
$expectedManifestHash = (Get-Content -LiteralPath $manifestHashPath -Raw).Trim().ToLowerInvariant()
$actualManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualManifestHash -ne $expectedManifestHash) { throw 'Manifest SHA256 does not match.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.formatVersion -ne 1) { throw 'Unsupported backup manifest version.' }
$expected = @{}
foreach ($entry in @($manifest.files)) {
  $relative = [string]$entry.path
  if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative.Contains(':') -or $relative.Contains('\') -or $expected.ContainsKey($relative)) {
    throw "Invalid or duplicate manifest path: $relative"
  }
  $full = Join-Path $backup ($relative.Replace('/', '\'))
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Backup file is missing: $relative" }
  $file = Get-Item -LiteralPath $full
  if ($file.Length -ne [int64]$entry.length) { throw "Backup file length differs: $relative" }
  $digest = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -ne [string]$entry.sha256) { throw "Backup file SHA256 differs: $relative" }
  $expected[$relative] = $true
}
$actualPaths = @(Get-FileManifest $backup | ForEach-Object { $_.path })
if ($actualPaths.Count -ne $expected.Count) { throw 'Backup file set differs from the manifest.' }
foreach ($path in $actualPaths) { if (-not $expected.ContainsKey($path)) { throw "Unexpected backup file: $path" } }

if (-not (Test-Path -LiteralPath $VerificationRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $VerificationRoot -Force | Out-Null
}
$verifyName = 'openmuse_verify_' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$verifyDir = Join-Path $VerificationRoot $verifyName
if (Test-Path -LiteralPath $verifyDir) { throw "Verification path already exists: $verifyDir" }
New-Item -ItemType Directory -Path $verifyDir | Out-Null
Protect-Directory $verifyDir
$reportPath = Join-Path $verifyDir 'verification-report.json'
$report = [ordered]@{
  status = 'started'
  startedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  backupDirectory = $backup
  verificationDatabase = $verifyName
  verificationDirectory = $verifyDir
  productionDatabaseTouched = $false
}
$snapshot = Join-Path $verifyDir 'restored-records.tmp.csv'
try {
  # createdb refuses an existing name. The script never drops or targets openmuse.
  Invoke-Pg $createdb @('-w', '-h', $PgHost, '-p', [string]$PgPort, '-U', $PgUser,
    '--maintenance-db', 'postgres', '--template', 'template0', '--encoding', 'UTF8', $verifyName)
  Invoke-Pg $pgRestore @('-w', '-h', $PgHost, '-p', [string]$PgPort, '-U', $PgUser,
    '-d', $verifyName, '--no-owner', '--no-acl', '--exit-on-error', (Join-Path $backup 'openmuse.dump'))
  $restoredDigest = Write-RecordSnapshot $psql $PgHost $PgPort $PgUser $verifyName $snapshot
  if ($restoredDigest -ne [string]$manifest.recordsSha256) { throw 'Restored record content SHA256 differs from the backup.' }
  Remove-Item -LiteralPath $snapshot -Force
  $restoredCounts = Get-RecordCounts $psql $PgHost $PgPort $PgUser $verifyName
  foreach ($property in $manifest.recordCounts.PSObject.Properties) {
    $kind = [string]$property.Name
    if (-not $restoredCounts.Contains($kind) -or $restoredCounts[$kind] -ne [int64]$property.Value) {
      throw "Restored record count differs for $kind"
    }
  }
  if ($restoredCounts.Count -ne @($manifest.recordCounts.PSObject.Properties).Count) {
    throw 'Restored record kind set differs from the backup.'
  }
  $kindDigests = Get-ImportantKindDigests $psql $PgHost $PgPort $PgUser $verifyName $verifyDir @($manifest.importantKinds)
  foreach ($property in $manifest.importantKindSha256.PSObject.Properties) {
    if (-not $kindDigests.Contains([string]$property.Name) -or $kindDigests[[string]$property.Name] -ne [string]$property.Value) {
      throw "Restored important record content differs for $($property.Name)"
    }
  }

  $recoverySource = Join-Path $backup 'recovery'
  $recoveryCopy = Join-Path $verifyDir 'recovery'
  Copy-Item -LiteralPath $recoverySource -Destination $recoveryCopy -Recurse -Force
  Protect-Directory $verifyDir
  foreach ($entry in @($manifest.files)) {
    $relative = [string]$entry.path
    if (-not $relative.StartsWith('recovery/')) { continue }
    $copy = Join-Path $verifyDir ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $copy -PathType Leaf)) { throw "Restored recovery file is missing: $relative" }
    $digest = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne [string]$entry.sha256) { throw "Restored recovery file SHA256 differs: $relative" }
  }
  $fileIds = @(Get-DbFileIds $psql $PgHost $PgPort $PgUser $verifyName)
  foreach ($id in $fileIds) {
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $recoveryCopy 'data\app\files') "$id.pdf") -PathType Leaf)) {
      throw "Restored database file record has no matching PDF: $id"
    }
  }
  $important = [ordered]@{}
  foreach ($kind in @($manifest.importantKinds)) {
    $important[$kind] = if ($restoredCounts.Contains([string]$kind)) { $restoredCounts[[string]$kind] } else { 0 }
  }
  $report['status'] = 'verified'
  $report['completedAtUtc'] = (Get-Date).ToUniversalTime().ToString('o')
  $report['recordsSha256'] = $restoredDigest
  $report['recordCounts'] = $restoredCounts
  $report['importantRecordCounts'] = $important
  $report['importantKindSha256'] = $kindDigests
  $report['pdfRecordCount'] = $fileIds.Count
  $report['recoveryFileCount'] = @($manifest.files | Where-Object { $_.path.StartsWith('recovery/') }).Count
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Protect-Directory $verifyDir
  Write-Output "RESTORE VERIFIED: $verifyName"
  Write-Output "Report: $reportPath"
  Write-Output 'Production database was not targeted. Verification database and files were retained for review.'
} catch {
  if (Test-Path -LiteralPath $snapshot) { Remove-Item -LiteralPath $snapshot -Force }
  $report['status'] = 'failed'
  $report['failure'] = $_.Exception.Message
  $report['completedAtUtc'] = (Get-Date).ToUniversalTime().ToString('o')
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Protect-Directory $verifyDir
  throw
}
