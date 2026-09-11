Set-StrictMode -Version Latest

function Stop-MonitoredProcessTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

    if ($Process.HasExited) { return }
    $TaskKill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path -LiteralPath $TaskKill -PathType Leaf) {
        & $TaskKill /PID $Process.Id /T /F *> $null
    } else {
        Stop-Process -Id $Process.Id -Force -ErrorAction Stop
    }
    if (-not $Process.WaitForExit(10000)) {
        throw "Process tree $($Process.Id) did not exit within 10 seconds."
    }
}

function Write-NewProcessOutput {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ref]$LineCount,
        [string]$Prefix = ""
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $Lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
    if ($Lines.Count -gt $LineCount.Value) {
        foreach ($Line in ($Lines | Select-Object -Skip $LineCount.Value)) {
            [Console]::WriteLine("{0}{1}", $Prefix, $Line)
        }
        $LineCount.Value = $Lines.Count
    }
}

function Invoke-MonitoredProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$StandardOutputPath,
        [Parameter(Mandatory)][string]$StandardErrorPath,
        [Parameter(Mandatory)][timespan]$MaxRuntime,
        [Parameter(Mandatory)][timespan]$InactivityTimeout,
        [timespan]$HeartbeatInterval = ([timespan]::FromSeconds(15)),
        [string]$ActivityName = "Agent"
    )

    if ($MaxRuntime -le [timespan]::Zero) { throw "MaxRuntime must be positive." }
    if ($InactivityTimeout -le [timespan]::Zero) { throw "InactivityTimeout must be positive." }
    if ($HeartbeatInterval -le [timespan]::Zero) { throw "HeartbeatInterval must be positive." }
    if ($StandardOutputPath -eq $StandardErrorPath) { throw "Output and error paths must differ." }

    New-Item -ItemType Directory -Path (Split-Path -Parent $StandardOutputPath) -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $StandardErrorPath) -Force | Out-Null
    Remove-Item -LiteralPath $StandardOutputPath, $StandardErrorPath -Force -ErrorAction SilentlyContinue

    $StartedAt = [DateTime]::UtcNow
    $LastActivityAt = $StartedAt
    $NextHeartbeatAt = $StartedAt.Add($HeartbeatInterval)
    $OutputLength = 0L
    $ErrorLength = 0L
    $OutputLines = 0
    $ErrorLines = 0
    $TimedOut = $false
    $TimeoutReason = $null

    $InvocationPath = "$StandardOutputPath.invocation.json"
    $WrapperPath = "$StandardOutputPath.runner.ps1"
    [ordered]@{
        filePath = $FilePath
        arguments = @($ArgumentList)
        stdout = $StandardOutputPath
        stderr = $StandardErrorPath
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $InvocationPath -Encoding utf8
    @'
param([Parameter(Mandatory)][string]$SpecPath)
$ErrorActionPreference = "Stop"
$Spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
$CommandArguments = @($Spec.arguments)
$ExitCode = 1
try {
    & $Spec.filePath @CommandArguments 1> $Spec.stdout 2> $Spec.stderr
    $ExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
} catch {
    $_ | Out-String | Add-Content -LiteralPath $Spec.stderr -Encoding utf8
    $ExitCode = 1
}
exit ([int]$ExitCode)
'@ | Set-Content -LiteralPath $WrapperPath -Encoding utf8

    $PowerShellHost = (Get-Process -Id $PID).Path
    $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $PowerShellHost
    $StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$WrapperPath`" -SpecPath `"$InvocationPath`""
    $StartInfo.WorkingDirectory = $WorkingDirectory
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) { throw "Failed to start monitored process: $FilePath" }
    [Console]::WriteLine("[{0}] {1} started (PID {2}).", $StartedAt.ToString("u"), $ActivityName, $Process.Id)

    try {
        while (-not $Process.HasExited) {
            Start-Sleep -Milliseconds 250
            $Now = [DateTime]::UtcNow
            foreach ($LogState in @(
                @{ Path = $StandardOutputPath; Length = [ref]$OutputLength; Lines = [ref]$OutputLines; Prefix = "" },
                @{ Path = $StandardErrorPath; Length = [ref]$ErrorLength; Lines = [ref]$ErrorLines; Prefix = "[stderr] " }
            )) {
                if (Test-Path -LiteralPath $LogState.Path -PathType Leaf) {
                    $Length = (Get-Item -LiteralPath $LogState.Path).Length
                    if ($Length -ne $LogState.Length.Value) {
                        $LogState.Length.Value = $Length
                        $LastActivityAt = $Now
                    }
                    Write-NewProcessOutput -Path $LogState.Path -LineCount $LogState.Lines -Prefix $LogState.Prefix
                }
            }

            $Elapsed = $Now - $StartedAt
            $Inactive = $Now - $LastActivityAt
            if ($Elapsed -ge $MaxRuntime) {
                $TimedOut = $true
                $TimeoutReason = if ($MaxRuntime.TotalMinutes -ge 1) {
                    "maximum runtime of $([math]::Round($MaxRuntime.TotalMinutes, 1)) minutes exceeded"
                } else {
                    "maximum runtime of $([math]::Round($MaxRuntime.TotalSeconds, 1)) seconds exceeded"
                }
                break
            }
            if ($Inactive -ge $InactivityTimeout) {
                $TimedOut = $true
                $TimeoutReason = if ($InactivityTimeout.TotalMinutes -ge 1) {
                    "no output for $([math]::Round($InactivityTimeout.TotalMinutes, 1)) minutes"
                } else {
                    "no output for $([math]::Round($InactivityTimeout.TotalSeconds, 1)) seconds"
                }
                break
            }
            if ($Now -ge $NextHeartbeatAt) {
                [Console]::WriteLine(
                    "[{0}] {1} is running: elapsed {2:c}, last output {3:c} ago, PID {4}.",
                    $Now.ToString("u"), $ActivityName, $Elapsed, $Inactive, $Process.Id
                )
                $NextHeartbeatAt = $Now.Add($HeartbeatInterval)
            }
        }

        if ($TimedOut) {
            [Console]::WriteLine(("[{0}] {1} watchdog stopped PID {2}: {3}." -f [DateTime]::UtcNow.ToString("u"), $ActivityName, $Process.Id, $TimeoutReason))
            Stop-MonitoredProcessTree -Process $Process
        } else {
            $Process.WaitForExit()
            $Process.Refresh()
        }
    } finally {
        Write-NewProcessOutput -Path $StandardOutputPath -LineCount ([ref]$OutputLines)
        Write-NewProcessOutput -Path $StandardErrorPath -LineCount ([ref]$ErrorLines) -Prefix "[stderr] "
        if (-not $Process.HasExited) { Stop-MonitoredProcessTree -Process $Process }
        Remove-Item -LiteralPath $InvocationPath, $WrapperPath -Force -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
        ExitCode = if ($TimedOut) { 124 } else { $Process.ExitCode }
        TimedOut = $TimedOut
        TimeoutReason = $TimeoutReason
        ProcessId = $Process.Id
        StartedAtUtc = $StartedAt.ToString("o")
        FinishedAtUtc = [DateTime]::UtcNow.ToString("o")
        StandardOutputPath = $StandardOutputPath
        StandardErrorPath = $StandardErrorPath
    }
}

Export-ModuleMember -Function Invoke-MonitoredProcess
