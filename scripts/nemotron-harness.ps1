#!/usr/bin/env pwsh
<# Runs Nemotron, monitors it, verifies its work independently, and returns failures for repair. #>

[CmdletBinding()]
param(
    [ValidateRange(1, 20)]
    [int]$MaxRounds = 5,
    [ValidateRange(1, 12)]
    [int]$ProviderRetries = 3,
    [ValidateRange(5, 1440)]
    [int]$MaxAgentMinutes = 240,
    [ValidateRange(5, 240)]
    [int]$InactivityMinutes = 30,
    [ValidateRange(5, 300)]
    [int]$HeartbeatSeconds = 15,
    [string]$PromptFile = "NEMOTRON_FINAL_REMEDIATION_PROMPT.md",
    [string]$Model = "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    [string]$SessionId,
    [switch]$PackageOnPass,
    [switch]$Elevated,
    [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PromptPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $PromptFile))
Import-Module (Join-Path $PSScriptRoot "nemotron-harness-core.psm1") -Force

function Test-IsAdministrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Elevated -and -not (Test-IsAdministrator)) {
    $ArgumentList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
        "-MaxRounds", $MaxRounds, "-ProviderRetries", $ProviderRetries,
        "-MaxAgentMinutes", $MaxAgentMinutes, "-InactivityMinutes", $InactivityMinutes,
        "-HeartbeatSeconds", $HeartbeatSeconds, "-PromptFile", "`"$PromptFile`"",
        "-Model", "`"$Model`"", "-Elevated"
    )
    if ($SessionId) { $ArgumentList += @("-SessionId", "`"$SessionId`"") }
    if ($PackageOnPass) { $ArgumentList += "-PackageOnPass" }
    if ($PreflightOnly) { $ArgumentList += "-PreflightOnly" }
    Write-Host "Requesting an elevated PowerShell token through UAC..." -ForegroundColor Yellow
    $PowerShellHost = (Get-Process -Id $PID).Path
    $Process = Start-Process -FilePath $PowerShellHost -Verb RunAs -WindowStyle Hidden -WorkingDirectory $ProjectRoot -ArgumentList $ArgumentList -Wait -PassThru
    exit $Process.ExitCode
}

if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) {
    throw "Prompt file not found: $PromptPath"
}
if (-not (Get-Command "opencode" -ErrorAction SilentlyContinue)) {
    throw "OpenCode is not installed or is not on PATH."
}

Push-Location $ProjectRoot
try {
    Write-Host "OpenCode: $(opencode --version)"
    Write-Host "Windows administrator token: $(Test-IsAdministrator)"
    & opencode debug agent nemotron-builder *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "The nemotron-builder agent configuration is invalid. Run: opencode debug agent nemotron-builder"
    }
    if ($PreflightOnly) {
        Write-Host "Harness preflight passed." -ForegroundColor Green
        exit 0
    }

    $RunId = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
    $RunDirectory = Join-Path $ProjectRoot ".artifacts\nemotron\runs\$RunId"
    New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null
    $Title = "nemotron-quality-$RunId"
    $StatusPath = Join-Path $RunDirectory "status.json"

    function Write-RunStatus {
        param([string]$State, [int]$Round, [int]$Attempt, [string]$Detail)
        [ordered]@{
            runId = $RunId
            state = $State
            round = $Round
            attempt = $Attempt
            maxRounds = $MaxRounds
            sessionId = $SessionId
            model = $Model
            detail = $Detail
            updatedAtUtc = [DateTime]::UtcNow.ToString("o")
        } | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding utf8
    }

    function Find-RunSession {
        param([string]$ExpectedTitle)
        for ($Lookup = 0; $Lookup -lt 5; $Lookup++) {
            $Sessions = @((& opencode session list -n 50 --format json | ConvertFrom-Json))
            $Found = ($Sessions | Where-Object { $_.title -eq $ExpectedTitle } | Select-Object -First 1).id
            if ($Found) { return $Found }
            Start-Sleep -Seconds 1
        }
        return $null
    }

    if ($SessionId) {
        $KnownSessions = @((& opencode session list -n 100 --format json | ConvertFrom-Json))
        if (-not ($KnownSessions | Where-Object { $_.id -eq $SessionId })) {
            throw "OpenCode session not found: $SessionId"
        }
        $SessionId | Set-Content -LiteralPath (Join-Path $RunDirectory "session-id.txt")
        Write-Host "Resuming existing OpenCode session: $SessionId" -ForegroundColor Cyan
    }

    for ($Round = 1; $Round -le $MaxRounds; $Round++) {
        Write-Host "`n===== Nemotron round $Round of $MaxRounds =====" -ForegroundColor Cyan
        $AgentLog = Join-Path $RunDirectory "round-$Round-agent.log"
        $AgentExit = 1

        for ($Attempt = 1; $Attempt -le $ProviderRetries; $Attempt++) {
            if (-not $SessionId) {
                $Instruction = "Implement the remediation prompt completely. Work directly in the repository, run the independent quality gate, and continue fixing failures. Give concise progress updates before and after each tool call."
                $OpenCodeArguments = @("run", "--agent", "nemotron-builder", "--model", $Model, "--auto", "--title", $Title, $Instruction)
            } else {
                $Instruction = if ($Round -eq 1) {
                    "Continue the current implementation. Work directly in the repository, report concise progress before and after tool calls, run the independent quality gate, and fix every failure until it passes."
                } else {
                    "The independent quality gate failed. Read .artifacts/nemotron/quality-report.json and its referenced logs, fix the root causes, add regression coverage, and rerun the gate. Report concise progress before and after tool calls."
                }
                $OpenCodeArguments = @("run", "--session", $SessionId, "--agent", "nemotron-builder", "--model", $Model, "--auto", $Instruction)
            }

            $StdoutLog = Join-Path $RunDirectory "round-$Round-attempt-$Attempt.stdout.log"
            $StderrLog = Join-Path $RunDirectory "round-$Round-attempt-$Attempt.stderr.log"
            Write-RunStatus -State "agent-running" -Round $Round -Attempt $Attempt -Detail "Nemotron is working"
            $Result = Invoke-MonitoredProcess -FilePath (Get-Command "opencode").Source `
                -ArgumentList $OpenCodeArguments -WorkingDirectory $ProjectRoot `
                -StandardOutputPath $StdoutLog -StandardErrorPath $StderrLog `
                -MaxRuntime ([timespan]::FromMinutes($MaxAgentMinutes)) `
                -InactivityTimeout ([timespan]::FromMinutes($InactivityMinutes)) `
                -HeartbeatInterval ([timespan]::FromSeconds($HeartbeatSeconds)) `
                -ActivityName "Nemotron round $Round/$MaxRounds, attempt $Attempt/$ProviderRetries"
            $AgentExit = $Result.ExitCode

            @(
                "ExitCode: $AgentExit"
                "TimedOut: $($Result.TimedOut)"
                "TimeoutReason: $($Result.TimeoutReason)"
                "--- stdout ---"
                if (Test-Path -LiteralPath $StdoutLog) { Get-Content -LiteralPath $StdoutLog }
                "--- stderr ---"
                if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog }
            ) | Set-Content -LiteralPath $AgentLog -Encoding utf8

            if (-not $SessionId) {
                $SessionId = Find-RunSession -ExpectedTitle $Title
                if ($SessionId) {
                    $SessionId | Set-Content -LiteralPath (Join-Path $RunDirectory "session-id.txt")
                    Write-Host "Captured resumable OpenCode session: $SessionId" -ForegroundColor DarkCyan
                }
            }

            if ($AgentExit -eq 0) { break }
            $FailureText = Get-Content -LiteralPath $AgentLog -Raw
            $TransientFailure = $Result.TimedOut -or $FailureText -match "(?i)408|429|500|502|503|504|overload|capacity|rate.?limit|timed? out|timeout|temporarily unavailable|connection (reset|closed)"
            if ($TransientFailure -and $Attempt -lt $ProviderRetries -and $SessionId) {
                $Delay = [Math]::Min(90, 5 * [Math]::Pow(2, $Attempt - 1))
                Write-RunStatus -State "provider-backoff" -Round $Round -Attempt $Attempt -Detail "Transient failure; retrying in $Delay seconds"
                Write-Host "Transient provider/CLI failure; preserving session and retrying in $Delay seconds." -ForegroundColor Yellow
                Start-Sleep -Seconds $Delay
                continue
            }
            break
        }

        if ($AgentExit -ne 0) {
            Write-Warning "OpenCode exited $AgentExit. The independent quality gate will still measure the repository state."
        }

        Write-RunStatus -State "quality-gate" -Round $Round -Attempt 0 -Detail "Running independent verification"
        & (Join-Path $PSScriptRoot "quality-gate.ps1")
        $GateExit = $LASTEXITCODE
        if ($GateExit -eq 0) {
            if ($PackageOnPass) {
                & (Join-Path $PSScriptRoot "quality-gate.ps1") -Package
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "The package gate failed; returning it to Nemotron on the next round."
                    continue
                }
            }
            Write-RunStatus -State "passed" -Round $Round -Attempt 0 -Detail "All requested gates passed"
            Write-Host "Nemotron work accepted by the independent quality gate." -ForegroundColor Green
            Write-Host "Session: $SessionId"
            Write-Host "Run logs: $RunDirectory"
            exit 0
        }
    }

    Write-RunStatus -State "failed" -Round $MaxRounds -Attempt 0 -Detail "Maximum repair rounds exhausted"
    Write-Error "Nemotron exhausted $MaxRounds rounds without passing the quality gate. Resume session $SessionId after reviewing .artifacts/nemotron/quality-report.json."
    exit 1
} finally {
    Pop-Location
}
