param(
  [Parameter(Mandatory = $true)][string]$Executable
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Executable)) {
  Write-Output "prewarm skipped: executable not found: $Executable"
  exit 0
}

$process = Start-Process -FilePath $Executable -ArgumentList '--prepare-runtime' -PassThru -WindowStyle Hidden
if (-not $process.WaitForExit(180000)) {
  try {
    $process.Kill()
  } catch {
    # The process may have exited between the timeout and Kill.
  }
  Write-Output 'prewarm timed out after 180 seconds'
  exit 124
}

Write-Output "prewarm exit code: $($process.ExitCode)"
exit $process.ExitCode
