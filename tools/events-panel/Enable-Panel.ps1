param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$localDir = Join-Path $projectRoot '.local'
$stateFile = Join-Path $localDir 'openshell-panel-state.json'

function Assert-NativeSuccess {
    if ($LASTEXITCODE -ne 0) { throw 'An OpenShell panel setup command failed.' }
}

if ($Remove) {
    if (Test-Path -LiteralPath (Join-Path $localDir 'openshell-panel.pid')) {
        $bridgePid = [int](Get-Content -LiteralPath (Join-Path $localDir 'openshell-panel.pid'))
        $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
        if ($bridgeProcess -and $bridgeProcess.Name -eq 'node.exe' -and $bridgeProcess.CommandLine.Contains((Join-Path $PSScriptRoot 'panel-service.mjs'))) {
            Stop-Process -Id $bridgePid
        }
    }
    Write-Host 'Panel service stopped.'
    return
}

$linuxUser = (& wsl.exe -d Ubuntu-24.04 -- id -un).Trim()
Assert-NativeSuccess
if ($linuxUser -notmatch '^[a-z_][a-z0-9_-]*[$]?$') { throw 'Unexpected Linux username.' }
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.capability -notmatch '^[a-f0-9]{64}$') { throw 'Invalid panel state. No changes made.' }
    $state.linuxUser = $linuxUser
} else {
    $randomBytes = New-Object byte[] 32
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
    $state = [pscustomobject]@{ linuxUser = $linuxUser; capability = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant() }
}
[IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$headers = @{ 'X-OpenShell-Panel' = $state.capability }
$bridgePath = Join-Path $PSScriptRoot 'panel-service.mjs'
# Hash of the service source, computed exactly like panel-service.mjs does (the files in service-files.txt, in order).
$sourceBytes = [Collections.Generic.List[byte]]::new()
foreach ($sourceName in (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'service-files.txt') | Where-Object { $_.Trim() })) { $sourceBytes.AddRange([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $sourceName))) }
$sha = [Security.Cryptography.SHA256]::Create()
try { $buildHash = -join ($sha.ComputeHash($sourceBytes.ToArray()) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }

function Get-Bridge {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18891/health' -Headers $headers -TimeoutSec 2
        if ($health.ok -and $health.service -eq 'openshell-panel') { return $health }
    } catch { }
    return $null
}

$running = Get-Bridge
$bridgeReady = [bool]($running -and $running.build -eq $buildHash)
if ($running -and -not $bridgeReady) {
    # The service is running older code. Replacing it would interrupt a sandbox that is still being created.
    $creating = @()
    try { $creating = @((Invoke-RestMethod -Uri 'http://127.0.0.1:18891/conversations/list' -Headers $headers -TimeoutSec 5).items | Where-Object status -eq 'creating') } catch { }
    if ($creating.Count -gt 0) {
        Write-Host 'A conversation sandbox is still being created, so the panel service keeps its previous code for now. Run Start OpenClaw again after creation finishes.' -ForegroundColor Yellow
        $bridgeReady = $true
    }
}
if (-not $bridgeReady) {
    if ($running) { Write-Host 'Panel service code changed. Restarting it...' }
    # Only a node.exe running this project's panel-service.mjs is ever stopped.
    $candidatePids = @()
    $oldPidFile = Join-Path $localDir 'openshell-panel.pid'
    if (Test-Path -LiteralPath $oldPidFile) { $candidatePids += [int](Get-Content -LiteralPath $oldPidFile) }
    try { $candidatePids += @(Get-NetTCPConnection -LocalPort 18891 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) } catch { }
    foreach ($oldBridgePid in ($candidatePids | Select-Object -Unique)) {
        $oldBridge = Get-CimInstance Win32_Process -Filter "ProcessId=$oldBridgePid" -ErrorAction SilentlyContinue
        if ($oldBridge -and $oldBridge.Name -eq 'node.exe' -and $oldBridge.CommandLine.Contains($bridgePath)) {
            Stop-Process -Id $oldBridgePid -ErrorAction SilentlyContinue
            Wait-Process -Id $oldBridgePid -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $nodePath -ArgumentList ('"' + $bridgePath + '"') -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 300
        $health = Get-Bridge
        if ($health -and $health.build -eq $buildHash) { $bridgeReady = $true; break }
    }
}
if (-not $bridgeReady) { throw 'The local events bridge could not start. Port 18891 may be in use.' }

Write-Host 'OpenShell panel service ready (port 18891).' -ForegroundColor Green
