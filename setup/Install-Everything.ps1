[CmdletBinding()]
param(
    [switch]$Elevated,
    [switch]$SkipWindowsPreparation
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$distro = 'Ubuntu-24.04'
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$linuxInstaller = Join-Path $PSScriptRoot 'wsl-linux\install-stack.sh'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Convert-ToWslPath([string]$Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $drive = $resolved.Substring(0, 1).ToLowerInvariant()
    return "/mnt/$drive/" + $resolved.Substring(3).Replace('\', '/')
}

try {
    Write-Host 'NemoClaw portable setup' -ForegroundColor Cyan
    Write-Host 'This installer is resumable and preserves existing sandboxes and data.'

    if (-not $Elevated -and -not (Test-Administrator)) {
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Elevated')
        if ($SkipWindowsPreparation) { $arguments += '-SkipWindowsPreparation' }
        $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
        exit $process.ExitCode
    }

    if (-not $SkipWindowsPreparation) {
        $distros = @(& wsl.exe --list --quiet 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() }
        if ($distros -notcontains $distro) {
            Write-Host "Installing $distro. Complete the Linux username/password window if it appears." -ForegroundColor Yellow
            & wsl.exe --install -d $distro
            if ($LASTEXITCODE -ne 0) { throw "WSL installation returned exit code $LASTEXITCODE." }
            Write-Host 'Ubuntu was installed. Finish its first-run account setup, restart Windows if requested, then run Install Everything.cmd again.' -ForegroundColor Yellow
            exit 10
        }

        & wsl.exe --set-version $distro 2
        if ($LASTEXITCODE -ne 0) { throw 'Unable to configure Ubuntu as WSL 2.' }

        if (-not (Test-Path -LiteralPath $dockerExe)) {
            $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
            if (-not $winget) { throw 'winget is unavailable. Install Microsoft App Installer, then rerun this installer.' }
            & winget.exe install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation returned exit code $LASTEXITCODE." }
        }
    }

    if (-not (Test-Path -LiteralPath $dockerDesktop)) { throw 'Docker Desktop is not installed.' }
    & $dockerExe info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Starting Docker Desktop...' -ForegroundColor Cyan
        Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
        $ready = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 5
            & $dockerExe info *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        }
        if (-not $ready) { throw 'Docker Desktop did not become ready. Complete its first-run screen and enable WSL integration for Ubuntu-24.04, then rerun.' }
    }

    & wsl.exe -d $distro -- docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker is not available inside Ubuntu-24.04. Enable Docker Desktop WSL integration for this distribution and rerun.'
    }

    # Node.js on Windows runs the OpenShell panel, the collector and the tests (standard library only; nothing to npm install).
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw 'Node.js 20 or newer is required and winget is unavailable. Install Node.js LTS from https://nodejs.org, then rerun this installer.' }
        Write-Host 'Installing Node.js LTS...' -ForegroundColor Cyan
        & winget.exe install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "Node.js installation returned exit code $LASTEXITCODE." }
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js was installed but is not on PATH yet. Open a new window and rerun this installer.' }
    }

    $linuxUser = (& wsl.exe -d $distro -- id -un).Trim()
    if (-not $linuxUser -or $linuxUser -eq 'root') { throw 'Complete the Ubuntu first-run user setup before continuing.' }
    $wslScript = Convert-ToWslPath $linuxInstaller

    Write-Host 'Continuing inside Ubuntu. A sudo password prompt may appear.' -ForegroundColor Cyan
    & wsl.exe -d $distro -- bash $wslScript
    if ($LASTEXITCODE -ne 0) { throw "The Ubuntu installer returned exit code $LASTEXITCODE." }

    Write-Host 'Applying the local OpenShell panel...' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'tools\events-panel\Enable-Panel.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'The OpenShell panel setup failed.' }

    Write-Host 'Installation and verification completed.' -ForegroundColor Green
    Write-Host 'Double-click Start OpenClaw Workspace.cmd to open the workspace.'
    exit 0
}
catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing is deleted automatically. Fix the reported prerequisite and run this installer again.'
    exit 1
}
