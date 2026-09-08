[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodeExe)
$ErrorActionPreference = 'Stop'
$taskBootstrapPath = Join-Path $PSScriptRoot 'start-host.mjs'
# Start-Process uses one Windows command line; quote the observed script path.
$taskProcess = Start-Process -FilePath $NodeExe -ArgumentList @(('"' + $taskBootstrapPath + '"')) -WindowStyle Hidden -PassThru
if (-not $taskProcess.WaitForExit(10000)) { throw 'Startup ambiguous: inspect the configured Host before retrying.' }
if ($taskProcess.ExitCode -ne 0) { throw 'DSH launcher failed. Check runtime installation and autoStart configuration.' }
Write-Output 'DSH launcher finished; authenticated readiness must still be checked.'
