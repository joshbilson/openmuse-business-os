Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Windows {
  if ($env:OS -ne 'Windows_NT') { throw 'These recovery scripts must run on Windows.' }
}

function Assert-Tool([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required PostgreSQL tool is missing: $Path" }
}

function Invoke-Pg([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL command failed: $([IO.Path]::GetFileName($Exe)) (exit $LASTEXITCODE)" }
}

function Protect-Directory([string]$Path) {
  Assert-Windows
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  $grants = @("*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  # Clear any explicit ACLs copied from source files before applying the
  # restricted recovery ACL to the directory and every child.
  & icacls.exe $Path /reset /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not reset copied recovery ACLs: $Path" }
  & icacls.exe $Path /inheritance:r /grant:r $grants[0] $grants[1] $grants[2] /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict backup ACLs: $Path" }
  # Windows pg_dump may create files with an empty DACL. Inheritable ACEs on
  # directories do not make those existing files readable; grant each file an
  # explicit non-inheritable ACE as well.
  $fileGrants = @("*${sid}:F", '*S-1-5-18:F', '*S-1-5-32-544:F')
  foreach ($file in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File)) {
    & icacls.exe $file.FullName /inheritance:r /grant:r $fileGrants[0] $fileGrants[1] $fileGrants[2] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict backup file ACL: $($file.FullName)" }
  }
}

function Assert-NoReparsePoints([string]$Path) {
  $items = @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse point found; review and include its target explicitly: $($item.FullName)"
    }
  }
}

function Get-RelativeFilePath([string]$Root, [string]$File) {
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($File)
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "File is outside the backup root: $full"
  }
  return $full.Substring($prefix.Length).Replace('\', '/')
}

function Get-FileManifest([string]$Root) {
  $result = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)) {
    $relative = Get-RelativeFilePath $Root $file.FullName
    if ($relative -eq 'manifest.json' -or $relative -eq 'manifest.sha256' -or $relative -eq '.incomplete') { continue }
    $result += [ordered]@{
      path = $relative
      length = [int64]$file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return @($result | Sort-Object { $_.path })
}

function Write-RecordSnapshot([string]$Psql, [string]$HostName, [int]$Port, [string]$UserName, [string]$Database, [string]$Output, [string]$Kind = '') {
  $target = [IO.Path]::GetFullPath($Output).Replace('\', '/').Replace("'", "''")
  if ($Kind -and $Kind -notmatch '^[a-z0-9-]+$') { throw 'Invalid record kind for snapshot.' }
  $filter = if ($Kind) { " WHERE kind='$Kind'" } else { '' }
  $query = "\copy (SELECT owner, kind, id, data::text, updated_at AT TIME ZONE 'UTC' FROM public.records$filter ORDER BY owner, kind, id) TO '$target' WITH (FORMAT csv)"
  Invoke-Pg $Psql @('-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', $HostName, '-p', [string]$Port, '-U', $UserName, '-d', $Database, '-c', $query) | Out-Null
  return (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ImportantKindDigests([string]$Psql, [string]$HostName, [int]$Port, [string]$UserName, [string]$Database, [string]$WorkingDirectory, [string[]]$Kinds) {
  $result = [ordered]@{}
  foreach ($kind in $Kinds) {
    $snapshot = Join-Path $WorkingDirectory ("records-$kind.tmp.csv")
    try { $result[$kind] = Write-RecordSnapshot $Psql $HostName $Port $UserName $Database $snapshot $kind }
    finally { if (Test-Path -LiteralPath $snapshot) { Remove-Item -LiteralPath $snapshot -Force } }
  }
  return $result
}

function Get-RecordCounts([string]$Psql, [string]$HostName, [int]$Port, [string]$UserName, [string]$Database) {
  $query = "SELECT kind || '|' || count(*) FROM public.records GROUP BY kind ORDER BY kind"
  $lines = @(& $Psql -X -w -A -t -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $UserName -d $Database -c $query)
  if ($LASTEXITCODE -ne 0) { throw "Could not count records in $Database" }
  $result = [ordered]@{}
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|', 2
    if ($parts.Count -ne 2) { throw 'Unexpected record count output' }
    $result[$parts[0]] = [int64]::Parse($parts[1])
  }
  return $result
}

function Get-DbFileIds([string]$Psql, [string]$HostName, [int]$Port, [string]$UserName, [string]$Database) {
  $query = "SELECT id FROM public.records WHERE kind='files' ORDER BY id"
  $lines = @(& $Psql -X -w -A -t -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $UserName -d $Database -c $query)
  if ($LASTEXITCODE -ne 0) { throw "Could not list file records in $Database" }
  return @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
