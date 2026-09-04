#!/usr/bin/env pwsh
<# Build and package NOC AI Assistant for Windows x64. #>

param(
    [string]$Version = "1.0.1",
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$SkipRuntime,
    [switch]$SkipPackaging,
    [switch]$Sign
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DesktopDir = Join-Path $ProjectRoot "apps\desktop"
$ElectronDir = Join-Path $DesktopDir "electron"
$BackendDir = Join-Path $ProjectRoot "backend"
$VirtualEnv = Join-Path $ProjectRoot ".venv"
$ReleaseDir = Join-Path $ElectronDir "release"

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE." }
}

Write-Host "Building NOC AI Assistant $Version" -ForegroundColor Cyan

if (-not $SkipRuntime) {
    & (Join-Path $PSScriptRoot "download-llama.ps1")
    if ($LASTEXITCODE -ne 0) { throw "llama.cpp runtime setup failed." }
}

if (-not $SkipBackend) {
    if (-not (Test-Path $VirtualEnv)) { Invoke-Checked "python" @("-m", "venv", $VirtualEnv) }
    $Python = Join-Path $VirtualEnv "Scripts\python.exe"
    Invoke-Checked $Python @("-m", "pip", "install", "-e", "$BackendDir[dev]")
    Invoke-Checked $Python @("-m", "pytest", "-q", (Join-Path $ProjectRoot "tests"))
    & (Join-Path $PSScriptRoot "build-python-runtime.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Portable Python backend runtime setup failed." }
}

if (-not $SkipFrontend) {
    $RendererDir = Join-Path $DesktopDir "renderer"
    Push-Location $RendererDir
    try {
        Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund", "--prefer-offline")
        Invoke-Checked "npm.cmd" @("run", "typecheck")
        Invoke-Checked "npm.cmd" @("run", "build")
    } finally { Pop-Location }
}

Push-Location $ElectronDir
try {
    Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund", "--prefer-offline")
    Invoke-Checked "npm.cmd" @("run", "build")
    if (-not $SkipPackaging) {
        if ($Sign) {
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "--x64", "--dir", "--config", "builder.yaml")
            & (Join-Path $PSScriptRoot "sign-windows.ps1") -Path (Join-Path $ReleaseDir "win-unpacked")
            if ($LASTEXITCODE -ne 0) { throw "Signing the unpacked application failed." }
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "nsis", "portable", "--x64", "--publish=never", "--prepackaged", (Join-Path $ReleaseDir "win-unpacked"), "--config", "builder.yaml")
            & (Join-Path $PSScriptRoot "sign-windows.ps1") -Path (Join-Path $ReleaseDir "NOC-AI-Assistant-Setup-$Version.exe"), (Join-Path $ReleaseDir "NOC-AI-Assistant-Portable-$Version.exe")
            if ($LASTEXITCODE -ne 0) { throw "Signing release artifacts failed." }
        } else {
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "--x64", "--publish=never", "--config", "builder.yaml")
        }
    }
} finally { Pop-Location }

if (-not $SkipPackaging) {
    $ExpectedNames = @(
        "NOC-AI-Assistant-Setup-$Version.exe",
        "NOC-AI-Assistant-Portable-$Version.exe"
    )
    $Artifacts = foreach ($Name in $ExpectedNames) {
        $Path = Join-Path $ReleaseDir $Name
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "Expected release artifact was not produced: $Name"
        }
        Get-Item -LiteralPath $Path
    }
    $ChecksumLines = foreach ($Artifact in $Artifacts) {
        $Hash = Get-FileHash -LiteralPath $Artifact.FullName -Algorithm SHA256
        "$($Hash.Hash)  $($Artifact.Name)"
    }
    Set-Content -LiteralPath (Join-Path $ReleaseDir "SHA256SUMS.txt") -Value $ChecksumLines -Encoding ascii
    Write-Host "Release artifacts:" -ForegroundColor Green
    $Artifacts | Select-Object Name, Length, LastWriteTime | Format-Table
}
