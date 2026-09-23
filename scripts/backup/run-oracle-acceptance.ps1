param(
  [switch]$Execute,
  [string]$Root = 'C:\OpenMuseBusinessOS'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$apiTask = 'OpenMuseBusinessOS-API'
$hermesTask = 'OpenMuseBusinessOS-Hermes'
$backupRoot = Join-Path $Root 'backups'
$artifactRoot = Join-Path $Root 'artifacts'

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}
function Listening([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Wait-ForPort([int]$port, [bool]$expected) {
  for ($i = 0; $i -lt 30; $i++) {
    if ((Listening $port) -eq $expected) { return }
    Start-Sleep -Seconds 1
  }
  throw "Port $port did not reach the expected listening state."
}

Assert ((Get-ScheduledTask -TaskName $apiTask).State -eq 'Running') 'Isolated OpenMuse API task is not running.'
Assert ((Get-ScheduledTask -TaskName $hermesTask).State -eq 'Running') 'Isolated Hermes task is not running.'
Assert (Listening 8791) 'Isolated OpenMuse API port is not listening.'
Assert (Listening 8766) 'Isolated Hermes port is not listening.'
Assert (Listening 5433) 'PostgreSQL port is not listening.'
foreach ($path in @('data\app', 'app\.env', 'secrets\pg-admin-password', 'hermes-home', 'workspace')) {
  Assert (Test-Path -LiteralPath (Join-Path $Root $path)) "Recovery source is missing: $path"
}
if (-not $Execute) {
  Write-Output 'READY: isolated API, isolated Hermes, PostgreSQL, and recovery sources are present. No writers stopped.'
  return
}

$backupDirectory = $null
$verificationDatabase = $null
$verificationReport = $null
$recordCounts = $null
$importantCounts = $null
$recordsSha256 = $null
$recoveryFileCount = $null
$pdfRecordCount = $null
$failure = $null
$apiHealthy = $false
$hermesHealthy = $false
$postgresHealthy = $false
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
try {
  & (Join-Path $Root 'runtime\stop.ps1') -Service api -DeploymentRoot $Root | Out-Null
  & (Join-Path $Root 'runtime\stop.ps1') -Service hermes -DeploymentRoot $Root | Out-Null
  Wait-ForPort 8791 $false
  Wait-ForPort 8766 $false
  Assert (Listening 5433) 'PostgreSQL unexpectedly stopped.'

  $env:PGPASSWORD = [IO.File]::ReadAllText((Join-Path $Root 'secrets\pg-admin-password')).Trim()
  $backupLines = @(& (Join-Path $Root 'app\scripts\backup\backup.ps1') `
    -Destination $backupRoot -AppRoot $Root -WritesQuiesced `
    -AdditionalRecoveryPaths @((Join-Path $Root 'hermes-home'), (Join-Path $Root 'workspace')))
  $created = @($backupLines | Where-Object { $_ -is [string] -and $_.StartsWith('Backup created: ') })
  Assert ($created.Count -eq 1) 'Backup did not return exactly one completed folder.'
  $backupDirectory = $created[0].Substring('Backup created: '.Length)
  Assert (-not (Test-Path -LiteralPath (Join-Path $backupDirectory '.incomplete'))) 'Backup is incomplete.'

  $verifyLines = @(& (Join-Path $Root 'app\scripts\backup\verify-restore.ps1') `
    -BackupDirectory $backupDirectory)
  $verified = @($verifyLines | Where-Object { $_ -is [string] -and $_.StartsWith('RESTORE VERIFIED: ') })
  $reported = @($verifyLines | Where-Object { $_ -is [string] -and $_.StartsWith('Report: ') })
  Assert ($verified.Count -eq 1 -and $reported.Count -eq 1) 'Isolated restore did not report verification.'
  $verificationDatabase = $verified[0].Substring('RESTORE VERIFIED: '.Length)
  $verificationReport = $reported[0].Substring('Report: '.Length)
  $report = Get-Content -LiteralPath $verificationReport -Raw | ConvertFrom-Json
  Assert ($report.status -eq 'verified') 'Restore report did not have verified status.'
  Assert ($report.productionDatabaseTouched -eq $false) 'Restore report says production was targeted.'
  $recordCounts = $report.recordCounts
  $importantCounts = $report.importantRecordCounts
  $recordsSha256 = $report.recordsSha256
  $recoveryFileCount = $report.recoveryFileCount
  $pdfRecordCount = $report.pdfRecordCount
} catch {
  $failure = $_.Exception.Message
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  try {
    if ((Get-ScheduledTask -TaskName $hermesTask).State -ne 'Running') { Start-ScheduledTask -TaskName $hermesTask }
    if ((Get-ScheduledTask -TaskName $apiTask).State -ne 'Running') { Start-ScheduledTask -TaskName $apiTask }
    Wait-ForPort 8766 $true
    Wait-ForPort 8791 $true
    $deployment = Get-Content -LiteralPath (Join-Path $Root 'secrets\deployment.json') -Raw | ConvertFrom-Json
    $hermesHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/health/detailed' `
      -Headers @{Authorization="Bearer $($deployment.hermesApiKey)"} -TimeoutSec 10
    $hermesHealthy = $hermesHealth.status -in @('ok', 'ready')
    $apiHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8791/api/health' -TimeoutSec 10
    $apiHealthy = [bool]$apiHealth.ok
    $postgresHealthy = Listening 5433
  } catch {
    if (-not $failure) { $failure = 'Service restart or health verification failed: ' + $_.Exception.Message }
  }
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$summary = [ordered]@{
  status = if (-not $failure -and $apiHealthy -and $hermesHealthy -and $postgresHealthy) { 'verified' } else { 'failed' }
  startedAtUtc = $startedAt
  completedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  backupDirectory = $backupDirectory
  verificationDatabase = $verificationDatabase
  verificationReport = $verificationReport
  recordCounts = $recordCounts
  importantRecordCounts = $importantCounts
  recordsSha256 = $recordsSha256
  recoveryFileCount = $recoveryFileCount
  pdfRecordCount = $pdfRecordCount
  productionDatabaseTargeted = $false
  apiHealthyAfter = $apiHealthy
  hermesHealthyAfter = $hermesHealthy
  postgresHealthyAfter = $postgresHealthy
  failure = $failure
}
$summaryPath = Join-Path $artifactRoot 'backup-acceptance.json'
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Output "Acceptance summary: $summaryPath"
if ($summary.status -ne 'verified') { throw 'Backup or isolated restore acceptance failed; see the sanitized summary.' }
Write-Output "RESTORE VERIFIED and services healthy: $verificationDatabase"
