#!/usr/bin/env pwsh
<# Authenticode-sign Windows release files with a trusted code-signing certificate. #>

param(
    [string[]]$Path,
    [switch]$Preflight,
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

if ($CertificateThumbprint) {
    $Certificate = Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $CertificateThumbprint.Replace(' ', '') -and $_.HasPrivateKey } |
        Select-Object -First 1
    if (-not $Certificate) { throw 'Requested code-signing certificate and private key were not found.' }
} else {
    if (-not $env:NOC_AI_CERT_PASSWORD) { throw 'Set NOC_AI_CERT_PASSWORD before signing with a PFX.' }
    $SecurePassword = ConvertTo-SecureString -String $env:NOC_AI_CERT_PASSWORD -AsPlainText -Force
    # The password is passed in memory, never to a child process command line.
    $Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        (Resolve-Path -LiteralPath $PfxPath).Path, $SecurePassword,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
}
if (-not $Certificate.HasPrivateKey -or $Certificate.NotAfter -le (Get-Date) -or $Certificate.NotBefore -gt (Get-Date)) {
    throw 'Code-signing certificate is expired, not yet valid, or lacks its private key.'
}
if (-not ($Certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })) {
    throw 'Certificate is not authorized for code signing.'
}
if ($Preflight) {
    Write-Host 'Signing certificate prerequisite is available.'
    if ($PfxPath) { $Certificate.Dispose(); $SecurePassword.Dispose() }
    return
}
if (-not $Path) { throw 'Provide at least one exact file or directory to sign.' }

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

$FilesToSign = @()
foreach ($File in $Files) {
    $Existing = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($Existing.Status -ne "Valid") { $FilesToSign += $File }
}

try {
    foreach ($File in $FilesToSign) {
        $Signed = Set-AuthenticodeSignature -LiteralPath $File.FullName -Certificate $Certificate -HashAlgorithm SHA256 -TimestampServer $TimestampUrl
        if ($Signed.Status -ne 'Valid') { throw "Authenticode signing did not produce a trusted signature: $($File.Name)." }
    }
} finally {
    if ($PfxPath) { $Certificate.Dispose(); $SecurePassword.Dispose() }
}

foreach ($File in $FilesToSign) {
    $Verification = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($Verification.Status -ne "Valid") { throw "Signature validation failed for $($File.FullName): $($Verification.StatusMessage)" }
}

Write-Host "Signed $($FilesToSign.Count) file(s); preserved $($Files.Count - $FilesToSign.Count) existing valid signature(s)." -ForegroundColor Green
