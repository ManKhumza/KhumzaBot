#!/usr/bin/env pwsh
<# Download the official llama.cpp Windows x64 CPU runtime. #>

param(
    [string]$Version,
    [string]$OutputDir = "runtimes\llama"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutputPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputDir))
if ($OutputPath -ne (Join-Path $ProjectRoot 'runtimes\llama')) { throw 'Runtime output must be the dedicated runtimes/llama directory.' }
$RuntimeLock = Get-Content -LiteralPath (Join-Path $ProjectRoot 'resources\runtime-lock.json') -Raw | ConvertFrom-Json
if ($Version -and $Version -ne $RuntimeLock.llama.version) { throw 'Runtime version must match resources/runtime-lock.json.' }
$Version = $RuntimeLock.llama.version
$ApiHeaders = @{ "User-Agent" = "NOC-AI-build" }

if ($Version -eq "latest") {
    $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10" -Headers $ApiHeaders
    $Release = $Releases | Where-Object { -not $_.draft -and $_.tag_name -like "b*" } | Select-Object -First 1
} else {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Version" -Headers $ApiHeaders
}

if (-not $Release) { throw "No suitable llama.cpp release was found." }
$AssetName = "llama-$($Release.tag_name)-bin-win-cpu-x64.zip"
$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $Asset) { throw "Release $($Release.tag_name) does not contain $AssetName." }

$RequiredFiles = @("llama-server.exe", "llama-cli.exe", "llama.dll", "llama-common.dll", "llama-server-impl.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-x64.dll")
$VersionFile = Join-Path $OutputPath "VERSION"
$Complete = (Test-Path $VersionFile) -and ((Get-Content $VersionFile -Raw).Trim() -eq $Release.tag_name)
foreach ($File in $RequiredFiles) { $Complete = $Complete -and (Test-Path (Join-Path $OutputPath $File)) }
if ($Complete) {
    Write-Host "llama.cpp $($Release.tag_name) is already installed." -ForegroundColor Green
    return
}

New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("nocai-llama-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir | Out-Null
$Archive = Join-Path $TempDir $AssetName

try {
    Write-Host "Downloading official llama.cpp $($Release.tag_name)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Archive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $RuntimeLock.llama.sha256) {
        throw 'llama.cpp archive checksum differs from the pinned runtime lock.'
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir -Force
    foreach ($File in $RequiredFiles) {
        $Source = Get-ChildItem -LiteralPath $TempDir -Recurse -File -Filter $File | Select-Object -First 1
        if (-not $Source) { throw "The downloaded runtime is missing $File." }
    }
    Get-ChildItem -LiteralPath $TempDir -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll" } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $OutputPath $_.Name) -Force
    }
    Set-Content -LiteralPath $VersionFile -Value $Release.tag_name -Encoding ascii
    Write-Host "llama.cpp runtime installed in $OutputPath" -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $TempDir) { Remove-Item -LiteralPath $TempDir -Recurse -Force }
}
