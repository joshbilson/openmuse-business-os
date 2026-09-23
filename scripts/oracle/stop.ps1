param(
  [ValidateSet('api','hermes')][string]$Service,
  [string]$DeploymentRoot = 'C:\OpenMuseBusinessOS'
)
$ErrorActionPreference = 'Stop'
$taskName = if ($Service -eq 'api') { 'OpenMuseBusinessOS-API' } else { 'OpenMuseBusinessOS-Hermes' }
$runner = "$DeploymentRoot\runtime\run.ps1"

if ($Service -eq 'hermes') {
  # Hermes knows its isolated profile PID and can flush its own state cleanly.
  $env:HERMES_HOME = "$DeploymentRoot\hermes-home"
  Push-Location "$DeploymentRoot\runtime\hermes-src"
  try {
    $ErrorActionPreference = 'Continue'
    & "$DeploymentRoot\runtime\hermes-venv\Scripts\python.exe" -m hermes_cli.main gateway stop
    Start-Sleep -Seconds 2
  } finally {
    Pop-Location
    $ErrorActionPreference = 'Stop'
  }
}

# Task Scheduler stops its PowerShell action but can orphan native children.
# Match this deployment's exact runner and service argument, then stop its tree.
$wrappers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($runner, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match "(?i)-Service\s+$Service(?:\s|$)"
}
foreach ($wrapper in $wrappers) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $wrapper.ProcessId /T /F | Out-Null
}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
