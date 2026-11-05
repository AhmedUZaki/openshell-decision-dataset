[CmdletBinding()]
param([string]$ProjectRoot)

# Compares the project tree with setup/checksums.json (schema 2) using the protection rules stored in that file.
# Reports three different problems: MISSING (listed, not on disk), MODIFIED (different SHA-256), UNREGISTERED (a protected
# source file the manifest does not list). Exit code 0 only when none of them occurs. Reads only.
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$manifestPath = Join-Path $ProjectRoot 'setup\checksums.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Write-Output 'FAIL  setup/checksums.json is missing'; exit 1 }
try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { Write-Output "FAIL  setup/checksums.json is not valid JSON: $($_.Exception.Message)"; exit 1 }
if ($manifest.schemaVersion -ne 2 -or $manifest.algorithm -ne 'SHA256' -or -not $manifest.files) {
    Write-Output 'FAIL  setup/checksums.json is not a schema 2 SHA256 manifest; run: node tools/integrity-check/source-manifest.mjs --write'
    exit 1
}
$rules = $manifest.protected
$rootFull = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')

$listed = @{}
foreach ($entry in $manifest.files) { $listed[($entry.path -replace '\\', '/')] = $entry.sha256 }

$missing = New-Object System.Collections.Generic.List[string]
$modified = New-Object System.Collections.Generic.List[string]
$unregistered = New-Object System.Collections.Generic.List[string]
$verified = 0
foreach ($path in ($listed.Keys | Sort-Object)) {
    $full = Join-Path $rootFull ($path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $missing.Add($path); continue }
    $actual = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $listed[$path]) { $modified.Add($path) } else { $verified++ }
}

# The protected source files that exist now (same rules as tools/events-panel/source-identity.mjs).
function Test-Excluded([string]$Rel) {
    if ($rules.exclude_files -contains $Rel) { return $true }
    foreach ($ext in $rules.exclude_extensions) { if ($Rel.ToLowerInvariant().EndsWith($ext)) { return $true } }
    return $false
}
$present = New-Object System.Collections.Generic.HashSet[string]
foreach ($dir in $rules.directories) {
    $base = Join-Path $rootFull $dir
    if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
    Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($rootFull.Length + 1) -replace '\\', '/'
        $parts = $rel.Split('/')
        $skip = $false
        foreach ($part in $parts[0..($parts.Count - 2)]) { if ($rules.exclude_directories -contains $part) { $skip = $true } }
        if (-not $skip -and -not (Test-Excluded $rel)) { [void]$present.Add($rel) }
    }
}
foreach ($file in (Get-ChildItem -LiteralPath $rootFull -File -Force)) {
    $isProtected = $false
    foreach ($pattern in $rules.root_file_patterns) { if ($file.Name -like $pattern) { $isProtected = $true } }
    if ($rules.root_files -contains $file.Name) { $isProtected = $true }
    if ($isProtected -and -not (Test-Excluded $file.Name)) { [void]$present.Add($file.Name) }
}
foreach ($extra in $rules.extra_files) { if (Test-Path -LiteralPath (Join-Path $rootFull ($extra -replace '/', '\')) -PathType Leaf) { [void]$present.Add($extra) } }
foreach ($rel in ($present | Sort-Object)) { if (-not $listed.ContainsKey($rel)) { $unregistered.Add($rel) } }

foreach ($p in $missing) { Write-Output "MISSING       $p" }
foreach ($p in $modified) { Write-Output "MODIFIED      $p" }
foreach ($p in $unregistered) { Write-Output "UNREGISTERED  $p" }
if ($missing.Count -or $modified.Count -or $unregistered.Count) {
    Write-Output "FAIL  $($missing.Count) missing, $($modified.Count) modified, $($unregistered.Count) unregistered ($verified verified)"
    exit 1
}
Write-Output "PASS  $verified protected source file(s) match setup/checksums.json"
exit 0
