$ErrorActionPreference = 'Stop'
$taskEntry = Join-Path $PSScriptRoot 'fake runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
. (Join-Path $PSScriptRoot '..\scripts\host-process.ps1') -EntryPath $taskEntry -NodeExe 'C:\new-node\node.exe'
function Get-ListenerPids { return @{ ok=$true; pids=@() } }
function Get-NodeProcesses {
  return @{ ok=$true; procs=@(@{pid=12345; startEpochMs=1; executablePath='C:\old-node\node.exe'; commandLine=('"C:\old-node\node.exe" "'+$taskEntry+'" web --host 127.0.0.1 --port 3080')}) }
}
$taskInspection=Get-Inspection
if (-not $taskInspection.ok -or -not $taskInspection.dsh.present) { throw 'An alternate Node executable must still block duplicate Host startup.' }
function Get-NodeProcesses { return @{ok=$true;procs=@(@{pid=12345;commandLine='';executablePath=$null})} }
$taskInspection=Get-Inspection
if ($taskInspection.ok -ne $false) { throw 'Unreadable Node command lines must fail closed.' }
Write-Output 'Windows Host identity guards passed (synthetic processes only).'
