param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$distroName = 'Ubuntu-24.04'
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$dockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Invoke-LinuxStep {
    param([string[]]$LinuxArguments)
    & wsl.exe -d $distroName @LinuxArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'A Linux startup step failed. See the message above.'
    }
}

try {
    Write-Host 'Starting OpenClaw + OpenShell Conversation Workspace...' -ForegroundColor Cyan
    $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $panelDir = Join-Path $projectRoot 'tools\events-panel'
    $serviceFiles = @(Get-Content -LiteralPath (Join-Path $panelDir 'service-files.txt') | Where-Object { $_.Trim() })
    foreach ($requiredFile in ($serviceFiles + 'service-files.txt', 'Enable-Panel.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $panelDir $requiredFile))) { throw "A required update file is missing: tools\events-panel\$requiredFile" }
    }
    if (-not (Test-Path -LiteralPath $dockerDesktopExe)) {
        throw 'Docker Desktop is not installed at the expected location.'
    }

    & $dockerExe info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Starting Docker Desktop...'
        Start-Process -FilePath $dockerDesktopExe -WindowStyle Hidden
    }

    $dockerReady = $false
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        & $dockerExe info --format '{{.ServerVersion}}' *> $null
        if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
        Write-Host "Waiting for Docker Desktop ($attempt/60)..."
        Start-Sleep -Seconds 5
    }
    if (-not $dockerReady) { throw 'Docker Desktop did not become ready within five minutes.' }

    Write-Host 'Checking Ubuntu and Docker integration...'
    Invoke-LinuxStep -LinuxArguments @('--', 'docker', 'info', '--format', '{{.OperatingSystem}}')
    $linuxUser = (& wsl.exe -d $distroName -- id -un).Trim()
    if ($LASTEXITCODE -ne 0 -or $linuxUser -notmatch '^[a-z_][a-z0-9_-]*[$]?$') {
        throw 'Could not determine the default Ubuntu username.'
    }
    $linuxCli = "/home/$linuxUser/.local/bin/nemoclaw"

    Write-Host 'Starting Ollama...'
    Invoke-LinuxStep -LinuxArguments @('-u', 'root', '--', 'systemctl', 'start', 'ollama')
    $ollamaReady = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        & wsl.exe -d $distroName -- curl -fsS --max-time 3 http://127.0.0.1:11434/api/version *> $null
        if ($LASTEXITCODE -eq 0) { $ollamaReady = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ollamaReady) { throw 'Ollama did not become ready.' }

    Write-Host 'Starting the managed gateway...'
    Invoke-LinuxStep -LinuxArguments @('--', 'systemctl', '--user', 'start', 'nemoclaw-openshell-gateway.service')

    Write-Host 'Checking and recovering the OpenClaw sandbox. This may take a few minutes...'
    # A sandbox started by the probe needs time for its gateway process to come up.
    $probeAttempts = 6
    for ($attempt = 1; $attempt -le $probeAttempts; $attempt++) {
        & wsl.exe -d $distroName -- env NEMOCLAW_DISABLE_TELEMETRY=1 $linuxCli my-assistant connect --probe-only
        if ($LASTEXITCODE -eq 0) { break }
        if ($attempt -eq $probeAttempts) { throw 'The OpenClaw sandbox did not become ready. See the messages above.' }
        Write-Host "The sandbox is still starting. Retrying in 10 seconds ($attempt/$probeAttempts)..." -ForegroundColor Yellow
        Start-Sleep -Seconds 10
    }

    Write-Host 'Preparing the authenticated dashboard link...'
    $dashboardOutput = & wsl.exe -d $distroName -- env NEMOCLAW_DISABLE_TELEMETRY=1 $linuxCli my-assistant dashboard-url --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Could not obtain the dashboard URL.' }
    $dashboardUrl = @($dashboardOutput | Where-Object { $_ -match '^http://127\.0\.0\.1:18789/(?:#.*)?$' } | Select-Object -Last 1)
    if ($dashboardUrl.Count -ne 1) { throw 'The dashboard did not return the expected local URL.' }

    $dashboardResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18789/' -TimeoutSec 15
    if ($dashboardResponse.StatusCode -ne 200) { throw 'The local dashboard is not responding.' }

    $panelSetup = Join-Path $projectRoot 'tools\events-panel\Enable-Panel.ps1'
    Write-Host 'Starting the latest OpenShell panel service...'
    & $panelSetup
    $localPanelState = Get-Content -LiteralPath (Join-Path $projectRoot '.local\openshell-panel-state.json') -Raw | ConvertFrom-Json
    $panelHeaders = @{ 'X-OpenShell-Panel' = $localPanelState.capability; Origin = 'http://127.0.0.1:18789' }
    $conversationState = Invoke-RestMethod -Uri 'http://127.0.0.1:18891/conversations/list' -Headers $panelHeaders -TimeoutSec 10
    $readyCount = @($conversationState.items | Where-Object status -eq 'ready').Count
    Write-Host "Panel service ready. Saved conversations: $readyCount"

    if (-not $CheckOnly) {
        Start-Process -FilePath $dashboardUrl[0]
        Write-Host 'OpenClaw is ready. The dashboard has opened in your browser.' -ForegroundColor Green
        Write-Host 'Collect data with Generate Dataset.cmd. You can close this window.'
    } else {
        Write-Host 'Startup checks passed. Browser opening was skipped.' -ForegroundColor Green
    }
    exit 0
} catch {
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Keep this window open to review the error. No installation or data deletion was attempted.'
    exit 1
}
