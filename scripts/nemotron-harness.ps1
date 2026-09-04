#!/usr/bin/env pwsh
<# Runs Nemotron, verifies its work independently, and returns failures for repair. #>

[CmdletBinding()]
param(
    [ValidateRange(1, 20)]
    [int]$MaxRounds = 5,
    [string]$PromptFile = "NEMOTRON_FINAL_REMEDIATION_PROMPT.md",
    [string]$Model = "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    [switch]$PackageOnPass,
    [switch]$Elevated,
    [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PromptPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $PromptFile))

function Test-IsAdministrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Elevated -and -not (Test-IsAdministrator)) {
    $ArgumentList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
        "-MaxRounds", $MaxRounds, "-PromptFile", "`"$PromptFile`"", "-Model", "`"$Model`"", "-Elevated"
    )
    if ($PackageOnPass) { $ArgumentList += "-PackageOnPass" }
    if ($PreflightOnly) { $ArgumentList += "-PreflightOnly" }
    Write-Host "Requesting an elevated PowerShell token through UAC..." -ForegroundColor Yellow
    $Process = Start-Process -FilePath "pwsh.exe" -Verb RunAs -WindowStyle Hidden -WorkingDirectory $ProjectRoot -ArgumentList $ArgumentList -Wait -PassThru
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
    $SessionId = $null

    for ($Round = 1; $Round -le $MaxRounds; $Round++) {
        Write-Host "`n===== Nemotron round $Round of $MaxRounds =====" -ForegroundColor Cyan
        $AgentLog = Join-Path $RunDirectory "round-$Round-agent.log"
        if ($Round -eq 1) {
            $Instruction = "Implement the remediation prompt completely. Work directly in the repository, run the independent quality gate, and continue fixing failures."
            & opencode run --agent nemotron-builder --model $Model --auto --title $Title $Instruction 2>&1 | Tee-Object -FilePath $AgentLog
        } else {
            $Instruction = "The independent quality gate failed. Read .artifacts/nemotron/quality-report.json and its referenced logs, fix the root causes, add regression coverage, and rerun the gate. Do not stop until it passes."
            & opencode run --session $SessionId --agent nemotron-builder --model $Model --auto $Instruction 2>&1 | Tee-Object -FilePath $AgentLog
        }
        $AgentExit = $LASTEXITCODE

        if (-not $SessionId) {
            $Sessions = @((& opencode session list -n 20 --format json | ConvertFrom-Json))
            $SessionId = ($Sessions | Where-Object { $_.title -eq $Title } | Select-Object -First 1).id
            if (-not $SessionId) { throw "Could not identify the OpenCode session named $Title." }
            $SessionId | Set-Content -LiteralPath (Join-Path $RunDirectory "session-id.txt")
        }

        if ($AgentExit -ne 0) {
            $ProviderFailure = Select-String -LiteralPath $AgentLog -Pattern "503|overload|capacity|temporarily unavailable" -Quiet
            if ($ProviderFailure -and $Round -lt $MaxRounds) {
                $Delay = [Math]::Min(60, 5 * [Math]::Pow(2, $Round - 1))
                Write-Host "Transient model-provider failure; preserving session and retrying in $Delay seconds." -ForegroundColor Yellow
                Start-Sleep -Seconds $Delay
                continue
            }
            Write-Warning "OpenCode exited $AgentExit. The quality gate will still establish the repository state."
        }

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
            Write-Host "Nemotron work accepted by the independent quality gate." -ForegroundColor Green
            Write-Host "Session: $SessionId"
            Write-Host "Run logs: $RunDirectory"
            exit 0
        }
    }

    Write-Error "Nemotron exhausted $MaxRounds rounds without passing the quality gate. Resume session $SessionId after reviewing .artifacts/nemotron/quality-report.json."
    exit 1
} finally {
    Pop-Location
}
