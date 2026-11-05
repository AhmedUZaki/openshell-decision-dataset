[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$distro = 'Ubuntu-24.04'
$failed = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
$pins = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pins.env')) {
    if ($line -match '^\s*([A-Z_]+)=(.*)$') { $pins[$Matches[1]] = $Matches[2].Trim() }
}
$expectedModel = $pins['MODEL']
$sandbox = $pins['SANDBOX_NAME']

function Check([string]$Name, [scriptblock]$Action) {
    try {
        $result = & $Action
        if ($LASTEXITCODE -ne 0) { throw "Exit code $LASTEXITCODE" }
        Write-Host "[PASS] $Name" -ForegroundColor Green
        if ($result) { $result | ForEach-Object { Write-Host "       $_" } }
    }
    catch {
        $script:failed = $true
        Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
    }
}

Check 'Ubuntu 24.04 on WSL 2' {
    $line = (& wsl.exe --list --verbose | Out-String) -replace "`0", ''
    if ($line -notmatch 'Ubuntu-24\.04\s+\w+\s+2') { throw 'Required WSL 2 distribution was not found.' }
}
Check 'Protected project source files (setup/checksums.json)' {
    # MISSING, MODIFIED and UNREGISTERED are reported separately by setup\Verify-Checksums.ps1.
    $report = @(& (Join-Path $PSScriptRoot 'Verify-Checksums.ps1') -ProjectRoot $projectRoot)
    if ($LASTEXITCODE -ne 0) { throw ("`n       " + ($report -join "`n       ")) }
    $report
}
Check 'Docker Desktop reachable from WSL' { & wsl.exe -d $distro -- docker info --format '{{.OperatingSystem}}' }
Check 'Ollama service' { & wsl.exe -d $distro -- curl -fsS http://127.0.0.1:11434/api/version }
Check "Ollama model $expectedModel" {
    $models = & wsl.exe -d $distro -- ollama list
    if (($models | Out-String) -notmatch [regex]::Escape($expectedModel)) { throw 'Configured model is missing.' }
}
function Check-Version([string]$Name, [string]$Expected, [string[]]$Command) {
    Check "$Name $Expected" {
        $out = (& wsl.exe -d $distro -- @Command | Out-String)
        if ($out -notmatch [regex]::Escape($Expected)) { throw "Expected $Expected, got: $($out.Trim())" }
    }
}
Check-Version 'Ollama' $pins['OLLAMA_VERSION'] @('ollama', '--version')
Check-Version 'NemoClaw CLI' $pins['NEMOCLAW_VERSION'] @('env', 'NEMOCLAW_DISABLE_TELEMETRY=1', 'bash', '-lc', '~/.local/bin/nemoclaw --version')
Check-Version 'OpenShell CLI' $pins['OPENSHELL_VERSION'] @('bash', '-lc', '~/.local/bin/openshell --version')
foreach ($preset in ($pins['POLICY_EXTRA_PRESETS'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    Check "Policy preset $preset applied to $sandbox" {
        $list = (& wsl.exe -d $distro -- env NEMOCLAW_DISABLE_TELEMETRY=1 bash -lc "~/.local/bin/nemoclaw $sandbox policy list" | Out-String)
        # Applied presets carry a source tag such as "[user-added]" or "[from openclaw agent]"; unapplied ones do not.
        if ($list -notmatch ('(?m)\s' + [regex]::Escape($preset) + ' \[(user-added|from [^\]]+)\]')) { throw "Preset $preset is not applied." }
    }
}
Check "Primary sandbox $sandbox" { & wsl.exe -d $distro -- env NEMOCLAW_DISABLE_TELEMETRY=1 bash -lc "~/.local/bin/nemoclaw $sandbox connect --probe-only" }

if ($failed) { exit 1 }
Write-Host 'All portable setup checks passed.' -ForegroundColor Cyan
exit 0
