param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$AppRoot = 'C:\OpenMuseBusinessOS',
  [string]$PgBin = 'C:\OpenMuseBusinessOS\runtime\pgsql\bin',
  [string]$PgHost = '127.0.0.1',
  [int]$PgPort = 5433,
  [string]$PgUser = 'openmuse_admin',
  [string]$Database = 'openmuse',
  [string[]]$AdditionalRecoveryPaths = @(),
  [string]$SecretsDirectory = 'C:\OpenMuseBusinessOS\secrets',
  [switch]$WritesQuiesced
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Windows
if (-not $WritesQuiesced) { throw 'Stop or quiesce OpenMuse, Hermes, and other database/file writers, then pass -WritesQuiesced.' }
$pgDump = Join-Path $PgBin 'pg_dump.exe'
$pgRestore = Join-Path $PgBin 'pg_restore.exe'
$psql = Join-Path $PgBin 'psql.exe'
foreach ($tool in @($pgDump, $pgRestore, $psql)) { Assert-Tool $tool }
$data = Join-Path $AppRoot 'data\app'
$cluster = [IO.Path]::GetFullPath((Join-Path $AppRoot 'data\postgres')).TrimEnd('\') + '\'
$envFile = Join-Path $AppRoot 'app\.env'
if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw "Application data folder is missing: $data" }
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Recovery environment file is missing: $envFile" }
if (-not (Test-Path -LiteralPath $SecretsDirectory -PathType Container)) { throw "Recovery secrets folder is missing: $SecretsDirectory" }
if (-not (Test-Path -LiteralPath (Join-Path $SecretsDirectory 'pg-admin-password') -PathType Leaf)) { throw 'PostgreSQL admin recovery secret is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $data 'session-signing-key') -PathType Leaf)) { throw 'Session signing key is missing; start the app before making a recovery backup.' }
Assert-NoReparsePoints $data
Assert-NoReparsePoints $SecretsDirectory
foreach ($path in $AdditionalRecoveryPaths) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Additional recovery path is missing: $path" }
  $fullPath = [IO.Path]::GetFullPath($path).TrimEnd('\')
  if ($fullPath.StartsWith($cluster, [StringComparison]::OrdinalIgnoreCase) -or
      ($fullPath + '\').Equals($cluster, [StringComparison]::OrdinalIgnoreCase) -or
      $cluster.StartsWith($fullPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Never byte-copy the live PostgreSQL cluster. Use pg_dump only.'
  }
  if (Test-Path -LiteralPath $path -PathType Container) { Assert-NoReparsePoints $path }
}
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$run = Join-Path $Destination ("openmuse-$stamp-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$runFull = [IO.Path]::GetFullPath($run)
foreach ($sourceRoot in @($cluster, ([IO.Path]::GetFullPath($data).TrimEnd('\') + '\'), ([IO.Path]::GetFullPath($SecretsDirectory).TrimEnd('\') + '\'))) {
  if ($runFull.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup destination cannot be inside live database, app data, or secrets.'
  }
}
New-Item -ItemType Directory -Path $run -ErrorAction Stop | Out-Null
Protect-Directory $run
$incomplete = Join-Path $run '.incomplete'
Set-Content -LiteralPath $incomplete -Value 'Backup is incomplete until manifest verification succeeds.' -Encoding ASCII

try {
  $preSnapshot = Join-Path $run 'records-before.tmp.csv'
  $preDigest = Write-RecordSnapshot $psql $PgHost $PgPort $PgUser $Database $preSnapshot
  Remove-Item -LiteralPath $preSnapshot -Force
  $dump = Join-Path $run 'openmuse.dump'
  Invoke-Pg $pgDump @('-w', '-h', $PgHost, '-p', [string]$PgPort, '-U', $PgUser, '-d', $Database,
    '--format=custom', '--no-owner', '--no-acl', '--file', $dump)
  # pg_dump on Windows can create a dump with no readable inherited DACL.
  # Apply the backup ACL before pg_restore opens it for the first check.
  Protect-Directory $run
  Invoke-Pg $pgRestore @('--list', $dump) | Out-Null

  $snapshot = Join-Path $run 'records-snapshot.tmp.csv'
  $recordDigest = Write-RecordSnapshot $psql $PgHost $PgPort $PgUser $Database $snapshot
  $counts = Get-RecordCounts $psql $PgHost $PgPort $PgUser $Database
  Remove-Item -LiteralPath $snapshot -Force
  $importantKinds = @('tasks', 'run-events', 'chat-threads', 'chat-messages', 'chat-runs', 'memories', 'business-connections', 'business-facts', 'business-syncs', 'files')
  $importantDigests = Get-ImportantKindDigests $psql $PgHost $PgPort $PgUser $Database $run $importantKinds

  $recovery = Join-Path $run 'recovery'
  $dataCopy = Join-Path $recovery 'data\app'
  $appCopy = Join-Path $recovery 'app'
  New-Item -ItemType Directory -Path $dataCopy -Force | Out-Null
  New-Item -ItemType Directory -Path $appCopy -Force | Out-Null
  foreach ($item in @(Get-ChildItem -LiteralPath $data -Force)) {
    Copy-Item -LiteralPath $item.FullName -Destination $dataCopy -Recurse -Force
  }
  Copy-Item -LiteralPath $envFile -Destination (Join-Path $appCopy '.env') -Force
  Copy-Item -LiteralPath $SecretsDirectory -Destination (Join-Path $recovery 'secrets') -Recurse -Force

  $extraMap = @()
  for ($i = 0; $i -lt $AdditionalRecoveryPaths.Count; $i++) {
    $source = [IO.Path]::GetFullPath($AdditionalRecoveryPaths[$i])
    $targetRelative = "extra/$i"
    $target = Join-Path $recovery ("extra\$i")
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    $extraMap += [ordered]@{ originalPath = $source; backupPath = $targetRelative }
  }

  foreach ($id in @(Get-DbFileIds $psql $PgHost $PgPort $PgUser $Database)) {
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $dataCopy 'files') "$id.pdf") -PathType Leaf)) {
      throw "A database file record has no copied PDF: $id"
    }
  }
  $postSnapshot = Join-Path $run 'records-after.tmp.csv'
  $postDigest = Write-RecordSnapshot $psql $PgHost $PgPort $PgUser $Database $postSnapshot
  Remove-Item -LiteralPath $postSnapshot -Force
  if ($preDigest -ne $recordDigest -or $recordDigest -ne $postDigest) {
    throw 'Database records changed during backup. Keep writers quiesced and retry.'
  }
  Protect-Directory $run
  Assert-NoReparsePoints $run
  $files = @(Get-FileManifest $run)
  $manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{ appRoot = [IO.Path]::GetFullPath($AppRoot); pgHost = $PgHost; pgPort = $PgPort; database = $Database }
    recordsSha256 = $recordDigest
    writesQuiescedAttested = $true
    beforeAfterRecordsMatched = $true
    recordCounts = $counts
    importantKinds = $importantKinds
    importantKindSha256 = $importantDigests
    additionalRecoveryPaths = $extraMap
    files = $files
  }
  $manifestPath = Join-Path $run 'manifest.json'
  $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath (Join-Path $run 'manifest.sha256') -Value $manifestHash -Encoding ASCII
  Protect-Directory $run
  Remove-Item -LiteralPath $incomplete -Force
  Write-Output "Backup created: $run"
  Write-Output "Records SHA256: $recordDigest"
  Write-Output "Files in manifest: $($files.Count)"
} catch {
  foreach ($temporary in @(Get-ChildItem -LiteralPath $run -Filter '*.tmp.csv' -File -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $temporary.FullName -Force -ErrorAction SilentlyContinue
  }
  Write-Error "Backup incomplete at $run. Do not use it for recovery. $($_.Exception.Message)"
  throw
}
