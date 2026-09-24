param(
  [switch]$Execute,
  [string]$DeploymentRoot = 'C:\OpenMuseBusinessOS',
  [string]$IdempotencyKey = 'restart-readonly-business-connections-20260923-a',
  [string]$ExpectedMerchantId = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$api = 'http://127.0.0.1:8791'
$hermes = 'http://127.0.0.1:8766'
$taskName = 'OpenMuseBusinessOS-API'

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}
function ApiGet([string]$path, [hashtable]$headers) {
  return Invoke-RestMethod -Uri "$api$path" -Headers $headers -TimeoutSec 15
}
function HermesGet([string]$path, [hashtable]$headers) {
  return Invoke-RestMethod -Uri "$hermes$path" -Headers $headers -TimeoutSec 15
}

Assert (Test-Path "$DeploymentRoot\secrets\deployment.json") 'Deployment credentials are missing'
Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') 'OpenMuse API task is not running'
Assert ((Get-ScheduledTask -TaskName 'OpenMuseBusinessOS-Hermes').State -eq 'Running') 'Hermes task is not running'
Assert ((Invoke-RestMethod -Uri "$api/api/health" -TimeoutSec 10).ok) 'OpenMuse API health failed'
if (-not $Execute) {
  Write-Output 'Ready: API and Hermes scheduled tasks are running; no task was created or restarted.'
  return
}

$secret = Get-Content "$DeploymentRoot\secrets\deployment.json" -Raw | ConvertFrom-Json
$session = Invoke-RestMethod -Uri "$api/api/session" -Method Post -ContentType 'application/json' -Body (@{accessKey=$secret.accessKey}|ConvertTo-Json -Compress) -TimeoutSec 15
$apiHeaders = @{Authorization="Bearer $($session.token)"}
$hermesHeaders = @{Authorization="Bearer $($secret.hermesApiKey)"}
$square = ApiGet '/api/business/connections/square/status' $apiHeaders
Assert ($square.status -eq 'verified') 'Square connection is not verified'
if (-not $ExpectedMerchantId) { $ExpectedMerchantId = ([string]$square.identity -split ':',2)[0] }
Assert ($ExpectedMerchantId -match '^[A-Za-z0-9_-]+$') 'Verified Square merchant ID is missing or malformed'
$prompt = 'Read-only restart acceptance check. Call the business_connections MCP tool exactly once. Report the verified Square merchant ID, merchant name, connection status, and source evidence. Explain the observations in several clear paragraphs. Do not call business_sync or any provider write tool; do not create notifications, memories, actions, or other tasks.'
$payload = @{
  idempotencyKey = $IdempotencyKey
  task = @{title='Read-only business connection restart check';prompt=$prompt;kind='agent';input=@{acceptanceId=$IdempotencyKey}}
}|ConvertTo-Json -Depth 8 -Compress
$created = Invoke-RestMethod -Uri "$api/api/operator/tasks" -Method Post -Headers $apiHeaders -ContentType 'application/json' -Body $payload -TimeoutSec 15
Assert ([bool]$created.id) 'No task ID returned'
$taskId = [string]$created.id
$detail = $null
$runId = $null
for ($i=0; $i -lt 90; $i++) {
  Start-Sleep -Milliseconds 500
  $detail = ApiGet "/api/operator/tasks/$taskId" $apiHeaders
  $runId = [string]$detail.task.state.hermesRunId
  if ($runId) { break }
  if ($detail.task.status -in @('failed','cancelled','succeeded')) { break }
}
Assert ([bool]$runId) "Task $taskId never saved a Hermes run ID (status $($detail.task.status))"
$before = HermesGet "/v1/runs/$runId" $hermesHeaders
Assert ($before.status -in @('queued','started','running','stopping')) "Hermes run finished before API restart: $($before.status)"

$apiStopped = $false
try {
  & "$DeploymentRoot\runtime\stop.ps1" -Service api -DeploymentRoot $DeploymentRoot
  $apiStopped = $true
  Start-Sleep -Seconds 2
  Assert (-not (Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue)) 'API still listens after stop'
  Assert ([bool](Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue)) 'Hermes stopped with the API'
  $during = HermesGet "/v1/runs/$runId" $hermesHeaders
  Start-ScheduledTask -TaskName $taskName
  $apiStopped = $false
} finally {
  if ($apiStopped) { Start-ScheduledTask -TaskName $taskName }
}

$healthy = $false
for ($i=0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try { $healthy = [bool](Invoke-RestMethod -Uri "$api/api/health" -TimeoutSec 3).ok } catch { $healthy = $false }
  if ($healthy) { break }
}
Assert $healthy 'API did not recover after restart'
$session2 = Invoke-RestMethod -Uri "$api/api/session" -Method Post -ContentType 'application/json' -Body (@{accessKey=$secret.accessKey}|ConvertTo-Json -Compress) -TimeoutSec 15
$apiHeaders = @{Authorization="Bearer $($session2.token)"}
$replayed = Invoke-RestMethod -Uri "$api/api/operator/tasks" -Method Post -Headers $apiHeaders -ContentType 'application/json' -Body $payload -TimeoutSec 15
Assert ($replayed.id -eq $taskId) 'Idempotent task replay returned another task ID'

for ($i=0; $i -lt 150; $i++) {
  $detail = ApiGet "/api/operator/tasks/$taskId" $apiHeaders
  if ($detail.task.status -in @('succeeded','failed','cancelled')) { break }
  Start-Sleep -Seconds 1
}
$after = HermesGet "/v1/runs/$runId" $hermesHeaders
$acceptEvents = @($detail.events | Where-Object {$_.title -eq 'Hermes accepted the task'})
Assert ($detail.task.status -eq 'succeeded') "Task did not succeed: $($detail.task.status)"
Assert ($detail.task.state.hermesRunId -eq $runId) 'Recovered task changed Hermes run ID'
Assert ($after.status -eq 'completed') "Original Hermes run did not complete: $($after.status)"
Assert ($after.model -eq 'gpt-6-astra') "Hermes reported unexpected model: $($after.model)"
Assert ($acceptEvents.Count -eq 1) "Expected one Hermes acceptance event, saw $($acceptEvents.Count)"
Assert ($detail.task.result -match [regex]::Escape($ExpectedMerchantId)) 'Task result lacks verified Square merchant ID'
Assert ((Get-ScheduledTask -TaskName 'OpenMuseBusinessOS-Hermes').State -eq 'Running') 'Hermes is no longer running'

$digest = [Security.Cryptography.SHA256]::Create()
try {
  $resultHash = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$detail.task.result))).Replace('-','').ToLowerInvariant()
} finally { $digest.Dispose() }
$evidence = [ordered]@{
  acceptance = 'durable-task-api-restart'
  passed = $true
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  taskId = $taskId
  hermesRunIdBefore = $runId
  hermesRunIdAfter = $detail.task.state.hermesRunId
  hermesStatusBefore = $before.status
  hermesStatusWhileApiStopped = $during.status
  hermesStatusAfter = $after.status
  reportedModel = $after.model
  taskStatus = $detail.task.status
  taskAttempts = $detail.task.attempts
  hermesAcceptedEventCount = $acceptEvents.Count
  artifactCount = @($detail.artifacts).Count
  verifiedMerchantId = $ExpectedMerchantId
  resultSha256 = $resultHash
}
$artifactDir = "$DeploymentRoot\artifacts"
New-Item -ItemType Directory -Force $artifactDir | Out-Null
$safeKey = $IdempotencyKey -replace '[^A-Za-z0-9_-]','-'
$artifactPath = "$artifactDir\task-restart-$safeKey.json"
$evidence | ConvertTo-Json -Depth 8 | Set-Content -Path $artifactPath -Encoding UTF8
Write-Output "PASS task=$taskId hermesRun=$runId taskStatus=$($detail.task.status) acceptedEvents=$($acceptEvents.Count) evidence=$artifactPath"
