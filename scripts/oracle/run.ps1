param(
  [ValidateSet('api','hermes')][string]$Service,
  [string]$DeploymentRoot = 'C:\OpenMuseBusinessOS'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:DO_NOT_TRACK = '1'
$env:COPILOTKIT_TELEMETRY_DISABLED = 'true'
New-Item -ItemType Directory -Force "$DeploymentRoot\logs" | Out-Null
if ($Service -eq 'api') {
  Set-Location "$DeploymentRoot\app"
  # Native programs legitimately write warnings to stderr. PowerShell 5 turns
  # redirected stderr into an error record, so Stop would kill a healthy child.
  $ErrorActionPreference = 'Continue'
  & 'C:\Program Files\nodejs\node.exe' "$DeploymentRoot\app\dist\apps\server\src\index.js" 1>> "$DeploymentRoot\logs\api.log" 2>> "$DeploymentRoot\logs\api.error.log"
} else {
  $env:HERMES_HOME = "$DeploymentRoot\hermes-home"
  Set-Location "$DeploymentRoot\runtime\hermes-src"
  $ErrorActionPreference = 'Continue'
  & "$DeploymentRoot\runtime\hermes-venv\Scripts\python.exe" -m hermes_cli.main gateway run --external-supervisor 1>> "$DeploymentRoot\logs\hermes.log" 2>> "$DeploymentRoot\logs\hermes.error.log"
}
exit $LASTEXITCODE
