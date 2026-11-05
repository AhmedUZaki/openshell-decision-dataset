# Starts the Safety Router data collector menu (safety-router-dataset\collect-data\menu.mjs). It holds no logic of its own: the menu, the selection, the preview and the
# confirmation all live in the Node program, which is started with a fixed argument list. It takes no options.
$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0) { Write-Host 'This launcher takes no options. Run it without arguments and use the numbered menu.'; exit 2 }
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'safety-router-dataset\collect-data\menu.mjs'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js was not found. Run Install Everything.cmd first.'; exit 2 }
if (-not (Test-Path -LiteralPath $cli)) { Write-Host "Missing $cli"; exit 2 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Push-Location $root
try { & $node $cli; exit $LASTEXITCODE }
finally { Pop-Location }
