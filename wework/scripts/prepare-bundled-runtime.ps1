$ErrorActionPreference = 'Stop'

# This script is copied next to runtimes.json and the harness runtime archive.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$catalogPath = Join-Path $here 'runtimes.json'
if (-not (Test-Path -LiteralPath $catalogPath)) { exit 0 }

$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$runtime = @($catalog.runtimes) | Where-Object { $_.role -eq 'core' } | Select-Object -First 1
if (-not $runtime -or -not $runtime.sourceFingerprint -or -not $runtime.assetName) { exit 0 }

$targetRoot = Join-Path $env:APPDATA 'io.wecode.wework\managed-runtimes\dsh'
$target = Join-Path $targetRoot $runtime.sourceFingerprint
$marker = Join-Path $target 'runtime.json'

# The app already has a valid runtime; nothing to do.
if (Test-Path -LiteralPath $marker) { exit 0 }

# Remove a partial extraction from an interrupted install/launch.
if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

$asset = Join-Path $here $runtime.assetName
if (-not (Test-Path -LiteralPath $asset)) { exit 0 }

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar.exe' }

& $tar -xzf $asset -C $target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath $marker)) { exit 1 }
exit 0
