#!/usr/bin/env pwsh
<# Build a portable backend runtime around Python's official Windows embed package. #>

param(
    [string]$PythonVersion = "3.11.9",
    [string]$OutputDir = "runtimes\python"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$OutputPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputDir))
if (-not $OutputPath.StartsWith($ProjectRoot + [System.IO.Path]::DirectorySeparatorChar)) {
    throw "Python runtime output must remain inside the project."
}

$VirtualPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VirtualPython)) { throw "Create the project .venv before building the Python runtime." }

$Marker = Join-Path $OutputPath "NOC_AI_RUNTIME_VERSION"
$NeedsBootstrap = $true
if ((Test-Path $Marker) -and ((Get-Content $Marker -Raw).Trim() -eq $PythonVersion)) {
    & (Join-Path $OutputPath "python.exe") -c "import backend.main"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Portable Python $PythonVersion base runtime is already installed; refreshing application code." -ForegroundColor Green
        $NeedsBootstrap = $false
    }
}

if ($NeedsBootstrap) {
    if (Test-Path $OutputPath) { Remove-Item -LiteralPath $OutputPath -Recurse -Force }
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
    $Archive = Join-Path ([System.IO.Path]::GetTempPath()) "nocai-python-$PythonVersion-embed-amd64.zip"
    $DownloadUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"

    Write-Host "Downloading official Python $PythonVersion embedded runtime..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $Archive -UseBasicParsing
    Expand-Archive -LiteralPath $Archive -DestinationPath $OutputPath -Force

    $PthFile = Get-ChildItem -LiteralPath $OutputPath -Filter "python*._pth" | Select-Object -First 1
    if (-not $PthFile) { throw "Python embedded path configuration was not found." }
    Set-Content -LiteralPath $PthFile.FullName -Encoding ascii -Value @("python311.zip", ".", "Lib\site-packages", "import site")
}

$SitePackages = Join-Path $OutputPath "Lib\site-packages"
New-Item -ItemType Directory -Path $SitePackages -Force | Out-Null
& $VirtualPython -m pip install --disable-pip-version-check --no-compile --upgrade --target $SitePackages (Join-Path $ProjectRoot "backend")
if ($LASTEXITCODE -ne 0) { throw "Installing backend runtime dependencies failed." }

Set-Content -LiteralPath $Marker -Value $PythonVersion -Encoding ascii
& (Join-Path $OutputPath "python.exe") -c "import backend.main; print('portable backend import OK')"
if ($LASTEXITCODE -ne 0) { throw "Portable backend runtime validation failed." }
