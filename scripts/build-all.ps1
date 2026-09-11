#!/usr/bin/env pwsh
<# Build and package NOC AI Assistant for Windows x64. #>

param(
    [string]$Version,
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
$AuthoritativeVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot 'VERSION') -Raw).Trim()
if ($Version -and $Version -ne $AuthoritativeVersion) { throw 'Version must match the authoritative VERSION file.' }
$Version = $AuthoritativeVersion
$Python = Join-Path $VirtualEnv 'Scripts\python.exe'
if ($Sign) { & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Preflight }

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE." }
}

Write-Host "Building NOC AI Assistant $Version" -ForegroundColor Cyan

$NodeVersion = [version]((& node --version).Trim() -replace '^v', '')
if ($LASTEXITCODE -ne 0 -or $NodeVersion -lt [version]'22.12.0') {
    throw 'Node.js 22.12.0 or newer is required by the pinned Electron dependency.'
}

# Backend regression tests execute the authoritative Electron and renderer
# TypeScript, so their compiler dependencies must exist even with SkipFrontend.
Push-Location $ElectronDir
try { Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund", "--prefer-offline") }
finally { Pop-Location }
$RendererDir = Join-Path $DesktopDir "renderer"
if (-not $SkipFrontend -or -not $SkipBackend) {
    Push-Location $RendererDir
    try { Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund", "--prefer-offline") }
    finally { Pop-Location }
}

if (-not $SkipRuntime) {
    & (Join-Path $PSScriptRoot "download-llama.ps1")
}

if (-not $SkipBackend) {
    if (-not (Test-Path $VirtualEnv)) { Invoke-Checked "python" @("-m", "venv", $VirtualEnv) }
    $Python = Join-Path $VirtualEnv "Scripts\python.exe"
    Invoke-Checked $Python @("-m", "pip", "install", "-c", (Join-Path $BackendDir 'constraints-windows.txt'), "-e", "$BackendDir[dev]")
    Invoke-Checked $Python @("-m", "pytest", "-q", (Join-Path $ProjectRoot "tests"))
    & (Join-Path $PSScriptRoot "build-python-runtime.ps1")
}
Invoke-Checked $Python @((Join-Path $PSScriptRoot 'release_integrity.py'), '--check-versions')

if (-not $SkipFrontend) {
    Push-Location $RendererDir
    try {
        Invoke-Checked "npm.cmd" @("run", "typecheck")
        Invoke-Checked "npm.cmd" @("run", "build")
    } finally { Pop-Location }
}

if (-not $SkipPackaging -and (Test-Path -LiteralPath $ReleaseDir)) {
    $ResolvedReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path
    if (-not $ResolvedReleaseDir.StartsWith($ElectronDir + [System.IO.Path]::DirectorySeparatorChar)) {
        throw "Release output must remain inside the Electron project."
    }
    Remove-Item -LiteralPath $ResolvedReleaseDir -Recurse -Force
}

Push-Location $ElectronDir
try {
    Invoke-Checked "npm.cmd" @("run", "build")
    if (-not $SkipPackaging) {
        if ($Sign) {
            $env:NOC_AI_SIGN_REQUESTED = '1'
            $env:NOC_AI_SIGN_POWERSHELL = (Get-Process -Id $PID).Path
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "--x64", "--dir", "--config", "builder.yaml", "-c.win.signtoolOptions.sign=../../../scripts/sign-electron.cjs", "-c.win.signtoolOptions.signingHashAlgorithms=sha256")
            & (Join-Path $PSScriptRoot "sign-windows.ps1") -Path (Join-Path $ReleaseDir "win-unpacked")
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "nsis", "portable", "--x64", "--publish=never", "--prepackaged", (Join-Path $ReleaseDir "win-unpacked"), "--config", "builder.yaml", "-c.win.signtoolOptions.sign=../../../scripts/sign-electron.cjs", "-c.win.signtoolOptions.signingHashAlgorithms=sha256")
            & (Join-Path $PSScriptRoot "sign-windows.ps1") -Path (Join-Path $ReleaseDir "NOC-AI-Assistant-Setup-$Version.exe"), (Join-Path $ReleaseDir "NOC-AI-Assistant-Portable-$Version.exe")
        } else {
            Write-Host 'UNSIGNED DEVELOPMENT BUILD: not approved for public distribution.' -ForegroundColor Yellow
            Invoke-Checked "npx.cmd" @("electron-builder", "--win", "--x64", "--publish=never", "--config", "builder.yaml", "-c.win.signExecutable=false")
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
    $IntegrityArguments = @((Join-Path $PSScriptRoot 'release_integrity.py'), '--release', $ReleaseDir, '--write')
    if ($Sign) { $IntegrityArguments += '--signed' }
    Invoke-Checked $Python $IntegrityArguments
    Invoke-Checked $Python @((Join-Path $PSScriptRoot 'release_integrity.py'), '--release', $ReleaseDir)
    Write-Host "Release artifacts:" -ForegroundColor Green
    $Artifacts | Select-Object Name, Length, LastWriteTime | Format-Table
}
