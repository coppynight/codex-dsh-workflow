<#
  host-process.ps1 - read-only DSH host process inspection for dsh-recover.mjs
  ============================================================================
  Owner: Codex+DSH+Claude long-running workflow (recovery helper support).

  Behavior (inspection mode, default):
    * Never kills, never writes, never restarts anything.
    * Reports (a) whether anything listens on TCP port $Port, (b) whether a
      process running the EXACT configured node executable path
      ($NodeExe) has a command line containing the EXACT configured DSH entry
      (node_modules/@deepseek-ai/dsh/lib/bin.js) together with web host/port
      arguments, and (c) whether the 3080 listener is owned by that exact DSH
      process (otherwise the listener is FOREIGN).
    * FAILS CLOSED: a failed Win32_Process query or a failed/absent listener
      enumeration returns ok=false.  Failure is NEVER converted into "no
      process" / "no listener", because that would permit a duplicate start.
      The netstat fallback verifies that netstat actually executed (exit 0)
      before its (possibly empty) output is trusted as absence.
    * Prints exactly ONE compact JSON document on stdout; never raw command
      lines, never log/credential content. Only PIDs, start times and owned-
      identity booleans are emitted.

  Behavior (guarded start mode, -StartGuard):
    * Used by dsh-recover.mjs only after an authenticated probe failed and a
      read-only inspection showed no listener and no matching DSH process.
    * Serializes the actual start with a Windows named mutex
      (Local\DSHRecoveryHostStart). While holding the mutex it RECHECKS the
      listener and matching process so that concurrent recoveries cannot both
      start a host. Only if both the outer inspection AND the in-mutex recheck
      succeeded (ok=true, clean) does it invoke Start-DSH.ps1.  If inspection
      is unavailable the start is refused (never blind).

  Output shape (machine readable, consumed by dsh-recover.mjs):
    {
      ok: bool,
      error: string|null,            // short, sanitized, only when ok=false
      probedAt: ISO, machine: name,
      port: int, hostAddr: string,
      listener:    { present: bool, pids: int[] },
      dsh:         { present: bool, pids: int[],
                     primaryPid: int|null, primaryStartEpochMs: number|null,
                     anyExactEntry: bool, anyHostArgs: bool, anyExeMatch: bool },
      ownsListener: bool,            // a matching DSH pid owns the 3080 listener
      foreignListener: bool,         // listener present but NOT owned by the DSH host
      startGuard: { attempted, started, detail } | null   // only with -StartGuard
    }

  Exit codes: 0 success; 1 fatal inspection/start error.
  No process is ever killed or modified by this script.

  Testability: when the file is dot-sourced (InvocationName -eq '.') only the
  functions are defined and no top-level inspection runs, so PowerShell unit
  tests can stub Get-CimInstance / Get-NetTCPConnection / netstat and drive
  Get-Inspection directly.
#>
[CmdletBinding()]
param(
    [int]    $Port          = 3080,
    [string] $HostAddr      = '127.0.0.1',
    [Parameter(Mandatory=$true)][string] $EntryPath,
    [Parameter(Mandatory=$true)][string] $NodeExe,
    [string] $StartScript   = '',
    [switch] $StartGuard,
    [int]    $MutexWaitMs   = 15000
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrEmpty($StartScript)) { $StartScript = Join-Path $PSScriptRoot 'start-host.ps1' }
$script:StartMutexName = 'DSHRecoveryHostStart-' + $Port

function Out-JsonLine {
    param($Object)
    ($Object | ConvertTo-Json -Depth 8 -Compress) | Write-Output
}

function ConvertTo-Short {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $text = ($Text -replace '\s+', ' ').Trim()
    $text = [regex]::Replace($text, '(\?token=|\btoken[:=]|bearer\s+)[^\s&"'';]+', '$1[redacted]', 'IgnoreCase')
    if ($text.Length -gt 240) { $text = $text.Substring(0, 240) + '...[truncated]' }
    return $text
}

function Get-QuoteTokens {
    # Quote-aware command-line tokenizer. Strips double/single quotes so that
    # paths with spaces stay one token. Returns object[] (empty when none).
    param([string]$Cmd)
    $tokens = @()
    if ([string]::IsNullOrEmpty($Cmd)) { return $tokens }
    $current = ''
    $inQuote = $false
    $quoteChar = [char]0
    foreach ($ch in $Cmd.ToCharArray()) {
        if ($inQuote) {
            if ($ch -eq $quoteChar) { $inQuote = $false }
            else { $current += [string]$ch }
        }
        else {
            if ($ch -eq '"' -or $ch -eq "'") { $inQuote = $true; $quoteChar = $ch }
            elseif ($ch -eq ' ' -or $ch -eq [char]9) {
                if ($current.Length -gt 0) { $tokens += $current; $current = '' }
            }
            else { $current += [string]$ch }
        }
    }
    if ($current.Length -gt 0) { $tokens += $current }
    return $tokens
}

function Test-PathEquals {
    # Case- and slash-style-insensitive full path equality.
    param([string]$PathA, [string]$PathB)
    if ([string]::IsNullOrEmpty($PathA) -or [string]::IsNullOrEmpty($PathB)) { return $false }
    return (($PathA -replace '\\','/').TrimEnd('/') -eq ($PathB -replace '\\','/').TrimEnd('/'))
}

function Test-EntryExact {
    # true iff any token equals the configured DSH entry path. Full-path
    # equality: never a bare substring match.
    param([object[]]$Tokens)
    foreach ($tok in $Tokens) {
        if ([string]::IsNullOrEmpty($tok)) { continue }
        if (Test-PathEquals -PathA $tok -PathB $EntryPath) { return $true }
    }
    return $false
}

function Test-ExeMatch {
    # true iff the process runs the configured node executable: either its
    # Win32_Process ExecutablePath or its argv0 command-line token equals
    # $NodeExe (case/slash-insensitive). Process NAME alone is never enough.
    param([object[]]$Tokens, [string]$ProcessExe)
    if (-not [string]::IsNullOrEmpty($ProcessExe) -and (Test-PathEquals -PathA $ProcessExe -PathB $NodeExe)) {
        return $true
    }
    foreach ($tok in $Tokens) {
        if ([string]::IsNullOrEmpty($tok)) { continue }
        if (Test-PathEquals -PathA $tok -PathB $NodeExe) { return $true }
    }
    return $false
}

function Test-HostArgs {
    # true iff tokens describe the configured web host: a 'web' token followed
    # by host/port arguments in space, equals or compact form.
    param([object[]]$Tokens)
    $seenWeb = $false; $hostOk = $false; $portOk = $false
    for ($i = 0; $i -lt $Tokens.Count; $i++) {
        $t = $Tokens[$i]
        if (-not $seenWeb) { if ($t -eq 'web') { $seenWeb = $true }; continue }
        if ($t -eq '--host') {
            if (($i + 1) -lt $Tokens.Count -and $Tokens[$i + 1] -eq $HostAddr) { $hostOk = $true; $i++ }
        } elseif ($t -eq ('--host' + $HostAddr) -or $t -eq ('--host=' + $HostAddr)) { $hostOk = $true }
        elseif ($t -eq '--port') {
            if (($i + 1) -lt $Tokens.Count -and $Tokens[$i + 1] -eq ([string]$Port)) { $portOk = $true; $i++ }
        } elseif ($t -eq ('--port' + $Port) -or $t -eq ('--port=' + $Port)) { $portOk = $true }
    }
    return ($seenWeb -and $hostOk -and $portOk)
}

function Get-ListenerPids {
    # PID(s) of processes listening on $Port, as a hashtable:
    #   @{ ok = bool; error = string|null; pids = int[] }
    # Fail-closed: an errored cmdlet is NOT an empty list. netstat is used as
    # a verified fallback whenever the cmdlet errored OR reported nothing, and
    # netstat's own execution result must be successful before its (possibly
    # empty) output may be interpreted as "nothing is listening".
    $pids = @()
    $tcpFailed = $false
    $tcpError = $null
    try {
        $rows = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
        foreach ($row in $rows) {
            $owner = 0
            if ($null -ne $row.OwningProcess) {
                try { $owner = [int]$row.OwningProcess } catch { $owner = 0 }
            }
            if ($owner -lt 0) { $owner = 0 }
            $pids += $owner
        }
        $pids = @($pids | Sort-Object -Unique)
    } catch {
        $tcpFailed = $true
        $tcpError = $_.Exception.Message
    }
    if ($tcpFailed -or $pids.Count -eq 0) {
        # Verified netstat fallback (covers cmdlet denial AND invisible rows).
        $netLines = @()
        $netExit = -1
        $netError = $null
        try {
            $netLines = @(netstat -ano -p tcp 2>$null)
            $netExit = $LASTEXITCODE
        } catch {
            $netError = $_.Exception.Message
        }
        if ($null -ne $netError -or $netExit -ne 0) {
            $detail = if ($netError) {
                $netError
            } elseif ($null -eq $netExit) {
                'netstat did not report an exit code'
            } else {
                "netstat exited with code $netExit"
            }
            if ($tcpError) { $detail = "Get-NetTCPConnection: $($tcpError); netstat fallback: $detail" }
            return @{ ok = $false; error = "listener enumeration unavailable: $detail"; pids = @() }
        }
        foreach ($line in $netLines) {
            if ($line -match 'LISTENING' -and $line -match ('TCP\s+[^\s]+:' + $Port + '\s')) {
                # e.g. "  TCP    127.0.0.1:3080   0.0.0.0:0    LISTENING    1234"
                if ($line -match '\s(\d+)\s*$') { $pids += [int]$Matches[1] }
            }
        }
        $pids = @($pids | Sort-Object -Unique)
    }
    return @{ ok = $true; error = $null; pids = @($pids) }
}

function Get-NodeProcesses {
    # All node.exe processes with pid, creation date, command line and
    # executable path, as a hashtable:
    #   @{ ok = bool; error = string|null; procs = array }
    # Fail-closed: a failed Win32_Process query is an error, never an empty
    # process list (an empty list here could otherwise authorize a blind start).
    try {
        $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
            Select-Object ProcessId, CreationDate, CommandLine, ExecutablePath)
        $result = @()
        foreach ($row in $rows) {
            $epoch = $null
            try {
                if ($row.CreationDate) {
                    $utc = ([datetime]$row.CreationDate).ToUniversalTime()
                    $epoch = [long](($utc - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds)
                }
            } catch { $epoch = $null }
            $result += @{
                pid            = [int]$row.ProcessId
                startEpochMs   = $epoch
                commandLine    = [string]$row.CommandLine
                executablePath = [string]$row.ExecutablePath
            }
        }
        return @{ ok = $true; error = $null; procs = @($result) }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message; procs = @() }
    }
}

function Get-Inspection {
    $listenerInfo = Get-ListenerPids
    $nodeInfo = Get-NodeProcesses

    if (-not $listenerInfo.ok -or -not $nodeInfo.ok) {
        # Fail closed: cannot classify -> never treated as "absent".
        $parts = @()
        if (-not $listenerInfo.ok) { $parts += ('listener: ' + $listenerInfo.error) }
        if (-not $nodeInfo.ok)     { $parts += ('process: ' + $nodeInfo.error) }
        return @{
            ok = $false
            error = (ConvertTo-Short -Text ($parts -join '; '))
            probedAt = [DateTime]::UtcNow.ToString('o')
            machine  = $env:COMPUTERNAME
            port     = $Port
            hostAddr = $HostAddr
            listener = @{ present = $false; pids = @() }
            dsh = @{
                present = $false; pids = @(); primaryPid = $null
                primaryStartEpochMs = $null
                anyExactEntry = $false; anyHostArgs = $false; anyExeMatch = $false
            }
            ownsListener = $false
            foreignListener = $false
            startGuard = $null
        }
    }

    $listenerPids = @($listenerInfo.pids)
    $listenerPresent = ($listenerPids.Count -gt 0)

    $anyExactEntry = $false
    $anyHostArgs   = $false
    $anyExeMatch   = $false
    $matchPids     = @()
    $primaryPid    = $null
    $primaryStart  = $null
    $byCreated     = @()
    foreach ($proc in $nodeInfo.procs) {
        if ([string]::IsNullOrWhiteSpace($proc.commandLine)) {
            return @{ ok = $false; error = 'A Node process has an unreadable command line; Host absence cannot be proven.' }
        }
        $tokens = @(Get-QuoteTokens -Cmd $proc.commandLine)
        $exeMatch   = Test-ExeMatch -Tokens $tokens -ProcessExe $proc.executablePath
        $entryExact = Test-EntryExact -Tokens $tokens
        $hostArgs   = Test-HostArgs -Tokens $tokens
        if ($exeMatch)   { $anyExeMatch   = $true }
        if ($entryExact) { $anyExactEntry = $true }
        if ($hostArgs)   { $anyHostArgs   = $true }
        # Another Node installation may run this same Host. It still blocks startup.
        if ($entryExact -and $hostArgs) {
            $matchPids += $proc.pid
            $byCreated += @{ pid = $proc.pid; startEpochMs = $proc.startEpochMs; created = $proc.startEpochMs }
        }
    }
    if ($byCreated.Count -gt 0) {
        $sorted = @($byCreated | Sort-Object { $_.created } -Descending)
        $primary = $sorted[0]
        $primaryPid   = $primary.pid
        $primaryStart = $primary.startEpochMs
    }

    $owns = $false
    if ($listenerPresent -and $matchPids.Count -gt 0) {
        foreach ($lp in $listenerPids) { if ($matchPids -contains $lp) { $owns = $true; break } }
    }

    return @{
        ok = $true
        error = $null
        probedAt = [DateTime]::UtcNow.ToString('o')
        machine  = $env:COMPUTERNAME
        port     = $Port
        hostAddr = $HostAddr
        listener = @{ present = $listenerPresent; pids = @($listenerPids) }
        dsh = @{
            present = ($matchPids.Count -gt 0)
            pids = @($matchPids)
            primaryPid = $primaryPid
            primaryStartEpochMs = $primaryStart
            anyExactEntry = $anyExactEntry
            anyHostArgs   = $anyHostArgs
            anyExeMatch   = $anyExeMatch
        }
        ownsListener = $owns
        foreignListener = ($listenerPresent -and -not $owns)
        startGuard = $null
    }
}

function Invoke-GuardedStart {
    param($Inspection)
    $guard = @{ attempted = $true; started = $false; detail = ''; error = $null }
    if ($null -eq $Inspection -or $Inspection.ok -ne $true) {
        $guard.detail = 'inspection unavailable; no start issued'
        return $guard
    }
    if ($Inspection.listener.present -or $Inspection.dsh.present) {
        $guard.detail = 'listener or matching DSH process present; no start issued'
        return $guard
    }
    $mutex = $null
    $owned = $false
    try {
        $mutex = New-Object System.Threading.Mutex($false, $script:StartMutexName)
        if ($mutex.WaitOne($MutexWaitMs)) {
            $owned = $true
            # Recheck under the mutex: prevents double start when two recoveries
            # raced between the outer inspection and here.
            $recheck = Get-Inspection
            if ($null -ne $recheck -and $recheck.ok -eq $false) {
                $guard.detail = 'inspection unavailable during mutex recheck; no start issued'
            } elseif ($recheck.listener.present -or $recheck.dsh.present) {
                $guard.detail = 'host appeared while waiting for start mutex; no start issued'
            } else {
                try {
                    $scriptLines = & $StartScript -NodeExe $NodeExe 2>&1
                    $msg = ($scriptLines | Out-String).Trim()
                    if ([string]::IsNullOrEmpty($msg)) { $msg = 'start script completed' }
                    $guard.started = $true
                    $guard.detail  = (ConvertTo-Short -Text $msg)
                } catch {
                    $guard.started = $false
                    $guard.error  = (ConvertTo-Short -Text $_.Exception.Message)
                    $guard.detail = 'start script failed; see error'
                }
            }
        } else {
            $guard.detail = 'start mutex busy; another guarded start in progress'
        }
    } catch {
        $guard.started = $false
        $guard.error  = (ConvertTo-Short -Text $_.Exception.Message)
        $guard.detail = 'guarded start failed; see error'
    } finally {
        if ($mutex) {
            if ($owned) { try { $mutex.ReleaseMutex() } catch { } }
            $mutex.Dispose()
        }
    }
    return $guard
}

# Dot-sourcing (tests) defines only the functions above; running the script
# executes the inspection / guarded start below.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $insp = Get-Inspection
        if ($StartGuard) {
            $insp.startGuard = Invoke-GuardedStart -Inspection $insp
        }
        Out-JsonLine $insp
        exit 0
    } catch {
        $short = ConvertTo-Short -Text $_.Exception.Message
        Out-JsonLine @{ ok = $false; error = $short }
        exit 1
    }
}
