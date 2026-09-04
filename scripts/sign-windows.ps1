#!/usr/bin/env pwsh
<# Authenticode-sign Windows release files with a trusted code-signing certificate. #>

param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,
    [string]$CertificateThumbprint = $env:NOC_AI_CERT_THUMBPRINT,
    [string]$PfxPath = $env:NOC_AI_CERT_PFX,
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

if (-not $CertificateThumbprint -and -not $PfxPath) {
    throw "Set NOC_AI_CERT_THUMBPRINT for an installed certificate or NOC_AI_CERT_PFX for a PFX file."
}
if ($CertificateThumbprint -and $PfxPath) {
    throw "Configure either a certificate thumbprint or a PFX path, not both."
}
if ($PfxPath -and -not (Test-Path -LiteralPath $PfxPath -PathType Leaf)) {
    throw "PFX file not found: $PfxPath"
}

$SignTool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq "x64" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $SignTool) { throw "SignTool was not found. Install the Windows 10/11 SDK." }

$Files = foreach ($Item in $Path) {
    $Resolved = Resolve-Path -LiteralPath $Item -ErrorAction Stop
    if (Test-Path -LiteralPath $Resolved -PathType Container) {
        Get-ChildItem -LiteralPath $Resolved -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll", ".pyd" }
    } else {
        Get-Item -LiteralPath $Resolved
    }
}
$Files = $Files | Sort-Object FullName -Unique
if (-not $Files) { throw "No signable files were found." }

$BaseArguments = @("sign", "/fd", "SHA256", "/td", "SHA256", "/tr", $TimestampUrl, "/d", "NOC AI Assistant")
if ($CertificateThumbprint) {
    $CertificateThumbprint = $CertificateThumbprint.Replace(" ", "")
    $Certificate = Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $CertificateThumbprint -and $_.HasPrivateKey } |
        Select-Object -First 1
    if (-not $Certificate) { throw "A code-signing certificate with thumbprint $CertificateThumbprint and a private key was not found." }
    $BaseArguments += @("/sha1", $CertificateThumbprint)
    if ($Certificate.PSParentPath -match "LocalMachine") { $BaseArguments += "/sm" }
} else {
    if (-not $env:NOC_AI_CERT_PASSWORD) { throw "Set NOC_AI_CERT_PASSWORD in the current shell before signing with a PFX." }
    $BaseArguments += @("/f", (Resolve-Path -LiteralPath $PfxPath).Path, "/p", $env:NOC_AI_CERT_PASSWORD)
}

$FilesToSign = @()
foreach ($File in $Files) {
    $Existing = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($Existing.Status -ne "Valid") { $FilesToSign += $File }
}

# Keep command lines short and reduce hardware-token authentication prompts.
$BatchSize = 20
for ($Offset = 0; $Offset -lt $FilesToSign.Count; $Offset += $BatchSize) {
    $LastIndex = [Math]::Min($Offset + $BatchSize - 1, $FilesToSign.Count - 1)
    $Batch = @($FilesToSign[$Offset..$LastIndex] | ForEach-Object { $_.FullName })
    & $SignTool.FullName @BaseArguments @Batch
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for the batch beginning with: $($Batch[0])" }
}

foreach ($File in $FilesToSign) {
    $Verification = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($Verification.Status -ne "Valid") { throw "Signature validation failed for $($File.FullName): $($Verification.StatusMessage)" }
}

Write-Host "Signed $($FilesToSign.Count) file(s); preserved $($Files.Count - $FilesToSign.Count) existing valid signature(s)." -ForegroundColor Green
