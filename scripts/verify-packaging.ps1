<#
.SYNOPSIS
    Verifies the packaged NOC AI Assistant installer meets security requirements.

.DESCRIPTION
    Checks:
    1. Installer exists and is a reasonable size
    2. Installer does not require Administrator privileges
    3. No secrets or credentials in the package
    4. Backend binary is present
    5. Bundled model files are present
    6. Code signing status

.PARAMETER InstallerPath
    Path to the directory containing the installer.

.EXAMPLE
    ./scripts/verify-packaging.ps1 -InstallerPath "apps/desktop/dist"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$FailCount = 0
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)

function Write-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail = "")
    if ($Passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor Yellow }
        $script:FailCount++
    }
}

Write-Host ""
Write-Host "=== NOC AI Assistant Packaging Verification ===" -ForegroundColor Cyan
Write-Host ""

# ── Check 1: Installer exists ──────────────────────────────────
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Container)) {
    Write-Check "Installer directory exists" $false $InstallerPath
    exit 1
}
$installer = Get-ChildItem -LiteralPath $InstallerPath -Filter "*Setup*.exe" -File |
    Select-Object -First 1
if ($null -eq $installer) {
    $installer = Get-ChildItem -LiteralPath $InstallerPath -Filter "*.exe" -File |
        Select-Object -First 1
}
Write-Check "Installer exists" ($null -ne $installer)

if ($null -eq $installer) {
    Write-Host "Cannot continue without installer. Aborting." -ForegroundColor Red
    exit 1
}

# ── Check 2: Installer size is reasonable ──────────────────────
$sizeMB = [math]::Round($installer.Length / 1MB, 2)
$reasonableSize = ($sizeMB -ge 10) -and ($sizeMB -le 2048)
Write-Check "Installer size reasonable ($sizeMB MB)" $reasonableSize `
    "Expected between 10 MB and 2 GB"

# ── Check 3: No secrets in package ─────────────────────────────
# Search for common secret patterns in the installer
# Note: We can't easily grep a binary NSIS installer, so we check
# the build directory for any leftover secret files
$secretFiles = @(Get-ChildItem -LiteralPath $InstallerPath -Recurse -File `
    -ErrorAction SilentlyContinue | Where-Object {
        $_.Extension -in @(".key", ".p12", ".pfx") -or
        $_.Name -eq ".env" -or
        ($_.Extension -eq ".pem" -and
            (Get-Content -LiteralPath $_.FullName -Raw) -match "PRIVATE KEY")
    })
$secretFiles = @($secretFiles)

Write-Check "No secret files in package" ($secretFiles.Count -eq 0) `
    (($secretFiles | ForEach-Object { $_.Name }) -join ", ")

# ── Check 4: Backend binary present in build ───────────────────
$backendBinary = @(Get-ChildItem -LiteralPath $InstallerPath -Recurse -File `
    -Filter "nocai-backend.exe" -ErrorAction SilentlyContinue)
$portablePython = @(Get-ChildItem -LiteralPath $InstallerPath -Recurse -File `
    -Filter "python.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]resources[\\/]python[\\/]' })
Write-Check "Backend runtime present" `
    (($backendBinary.Count -gt 0) -or ($portablePython.Count -gt 0))

# ── Check 5: Model files present ───────────────────────────────
$modelFiles = @(Get-ChildItem -LiteralPath $InstallerPath -Recurse -File `
    -Filter "*.gguf" -ErrorAction SilentlyContinue)
Write-Check "GGUF model files present" ($modelFiles.Count -gt 0)

# The build configuration is the authoritative elevation policy for NSIS.
$builderConfig = Join-Path $ProjectRoot "apps\desktop\electron-builder.yml"
$builderText = if (Test-Path -LiteralPath $builderConfig) {
    Get-Content -LiteralPath $builderConfig -Raw
} else { "" }
Write-Check "Installer is user-scope" `
    ($builderText -match '(?m)^\s*perMachine:\s*false\s*$')
Write-Check "Executable runs as invoker" `
    ($builderText -match '(?m)^\s*requestedExecutionLevel:\s*asInvoker\s*$')

# ── Check 6: Code signing status ───────────────────────────────
try {
    $sig = Get-AuthenticodeSignature -FilePath $installer.FullName
    $isSigned = ($sig.Status -eq "Valid")
    if ($RequireSignature) {
        Write-Check "Installer is code-signed" $isSigned `
            "Signature status: $($sig.Status)"
    } elseif ($isSigned) {
        Write-Check "Installer is code-signed" $true
    } else {
        Write-Host "  [WARN] Unsigned builds will trigger Smart App Control warnings." `
            -ForegroundColor Yellow
        Write-Host "  [WARN] This is acceptable for development builds only." `
            -ForegroundColor Yellow
    }
} catch {
    Write-Check "Code signature check" (-not $RequireSignature) `
        "Failed to check signature: $_"
}

# ── Summary ────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Verification Summary ===" -ForegroundColor Cyan

if ($FailCount -eq 0) {
    Write-Host "All checks passed." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$FailCount check(s) failed." -ForegroundColor Red
    exit 1
}
