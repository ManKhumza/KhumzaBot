#!/usr/bin/env pwsh
<# Independent, machine-readable verification for agent and developer changes. #>

[CmdletBinding()]
param(
    [switch]$Package,
    [string]$ReportPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReportPath) {
    $ReportPath = Join-Path $ProjectRoot ".artifacts\nemotron\quality-report.json"
}
$ReportPath = [System.IO.Path]::GetFullPath($ReportPath)
$ReportDirectory = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
$LogDirectory = Join-Path $ReportDirectory "gate-logs"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$script:Results = [System.Collections.Generic.List[object]]::new()

function Add-GateResult {
    param([string]$Name, [bool]$Passed, [double]$Seconds, [string]$Log, [string]$Detail)
    $script:Results.Add([ordered]@{
        name = $Name
        passed = $Passed
        duration_seconds = [Math]::Round($Seconds, 2)
        log = $Log
        detail = $Detail
    })
}

function Invoke-GateStep {
    param(
        [string]$Name,
        [string]$Executable,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $ProjectRoot
    )
    $SafeName = $Name -replace '[^a-zA-Z0-9_-]', '-'
    $LogPath = Join-Path $LogDirectory "$SafeName.log"
    $StderrPath = Join-Path $LogDirectory "$SafeName.stderr.log"
    $Timer = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n==> $Name" -ForegroundColor Cyan
    $ExitCode = 1
    $Failure = $null
    Push-Location $WorkingDirectory
    try {
        # Native tools legitimately use stderr for warnings. Do not let
        # ErrorActionPreference turn a successful native invocation into a
        # PowerShell exception; the process exit code is authoritative.
        $PreviousErrorPreference = $ErrorActionPreference
        $PreviousNativePreference = $PSNativeCommandUseErrorActionPreference
        $ErrorActionPreference = "Continue"
        $PSNativeCommandUseErrorActionPreference = $false
        & $Executable @Arguments 2> $StderrPath | Tee-Object -FilePath $LogPath
        $ExitCode = $LASTEXITCODE
        if ($null -eq $ExitCode) { $ExitCode = 0 }
        if (Test-Path -LiteralPath $StderrPath) {
            Get-Content -LiteralPath $StderrPath |
                Tee-Object -FilePath $LogPath -Append |
                ForEach-Object { Write-Host $_ }
        }
    } catch {
        $Failure = $_.Exception.Message
        $Failure | Tee-Object -FilePath $LogPath -Append | Write-Host
    } finally {
        $ErrorActionPreference = $PreviousErrorPreference
        $PSNativeCommandUseErrorActionPreference = $PreviousNativePreference
        Pop-Location
        $Timer.Stop()
    }
    $Passed = ($ExitCode -eq 0 -and -not $Failure)
    $Detail = if ($Passed) { "exit 0" } elseif ($Failure) { $Failure } else { "exit $ExitCode" }
    Add-GateResult -Name $Name -Passed $Passed -Seconds $Timer.Elapsed.TotalSeconds -Log $LogPath -Detail $Detail
    if ($Passed) { Write-Host "PASS: $Name" -ForegroundColor Green }
    else { Write-Host "FAIL: $Name ($Detail)" -ForegroundColor Red }
}

$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PowerShellExecutable = (Get-Process -Id $PID).Path
$EmbeddingModel = Join-Path $ProjectRoot "resources\models\bge-small-en-v1.5-q8_0.gguf"
$LlamaServer = Join-Path $ProjectRoot "runtimes\llama\llama-server.exe"
$ExpectedEmbeddingHash = "F046DB1DC724CF4F6F0A0C5917E922823B73EB1D27B8F9A9C2797F7866974804"

$PreflightTimer = [System.Diagnostics.Stopwatch]::StartNew()
$PreflightProblems = [System.Collections.Generic.List[string]]::new()
foreach ($RequiredPath in @($Python, $EmbeddingModel, $LlamaServer)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        $PreflightProblems.Add("Missing required file: $RequiredPath")
    }
}
if (Test-Path -LiteralPath $EmbeddingModel -PathType Leaf) {
    $ActualHash = (Get-FileHash -LiteralPath $EmbeddingModel -Algorithm SHA256).Hash
    if ($ActualHash -ne $ExpectedEmbeddingHash) {
        $PreflightProblems.Add("Embedding model SHA-256 mismatch (actual $ActualHash)")
    }
}
foreach ($Command in @("node", "npm.cmd")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        $PreflightProblems.Add("Required command is unavailable: $Command")
    }
}
$PreflightTimer.Stop()
$PreflightLog = Join-Path $LogDirectory "preflight.log"
if ($PreflightProblems.Count -eq 0) {
    "All required tools and resource hashes are valid." | Set-Content -LiteralPath $PreflightLog
} else {
    $PreflightProblems | Set-Content -LiteralPath $PreflightLog
}
Add-GateResult -Name "preflight and resource integrity" -Passed ($PreflightProblems.Count -eq 0) -Seconds $PreflightTimer.Elapsed.TotalSeconds -Log $PreflightLog -Detail ($PreflightProblems -join "; ")

$SecurityTimer = [System.Diagnostics.Stopwatch]::StartNew()
$SecurityProblems = [System.Collections.Generic.List[string]]::new()
$SecurityPaths = @(
    "backend\security\__init__.py",
    "backend\security\dpapi.py",
    "backend\security\encryption.py",
    "apps\desktop\electron-builder.yml",
    ".github\workflows\build-windows.yml",
    "scripts\verify-packaging.ps1",
    "tests\test_security.py"
)
foreach ($RelativePath in $SecurityPaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $RelativePath) -PathType Leaf)) {
        $SecurityProblems.Add("Missing security deliverable: $RelativePath")
    }
}
$BuilderConfigPath = Join-Path $ProjectRoot "apps\desktop\electron-builder.yml"
if (Test-Path -LiteralPath $BuilderConfigPath) {
    $BuilderConfig = Get-Content -LiteralPath $BuilderConfigPath -Raw
    if ($BuilderConfig -notmatch '(?m)^\s*perMachine:\s*false\s*$') {
        $SecurityProblems.Add("Windows installer is not explicitly user-scope")
    }
    if ($BuilderConfig -notmatch '(?m)^\s*requestedExecutionLevel:\s*asInvoker\s*$') {
        $SecurityProblems.Add("Windows executable is not explicitly configured asInvoker")
    }
}
$TrackedSourceFiles = @(& git -C $ProjectRoot ls-files -- "backend/*.py" "apps/*.ts" "apps/*.tsx" "scripts/*.ps1")
foreach ($SourceFile in $TrackedSourceFiles) {
    $AbsoluteSourcePath = Join-Path $ProjectRoot $SourceFile
    if ((Get-Content -LiteralPath $AbsoluteSourcePath -Raw) -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}') {
        $SecurityProblems.Add("Potential embedded credential in tracked source: $SourceFile")
    }
}
$TrackedSecretFiles = @(& git -C $ProjectRoot ls-files -- "*.pem" "*.key" "*.p12" "*.pfx" ".env")
if ($TrackedSecretFiles.Count -gt 0) {
    $SecurityProblems.Add("Certificate, key, or environment secret file is tracked")
}
$SecurityTimer.Stop()
$SecurityLog = Join-Path $LogDirectory "security-configuration.log"
if ($SecurityProblems.Count -eq 0) {
    "Encryption and Windows packaging security controls are present." | Set-Content -LiteralPath $SecurityLog
} else {
    $SecurityProblems | Set-Content -LiteralPath $SecurityLog
}
Add-GateResult -Name "security configuration" -Passed ($SecurityProblems.Count -eq 0) -Seconds $SecurityTimer.Elapsed.TotalSeconds -Log $SecurityLog -Detail ($SecurityProblems -join "; ")

if (Test-Path -LiteralPath $Python -PathType Leaf) {
    Invoke-GateStep "Python compile" $Python @("-m", "compileall", "-q", "backend")
    Invoke-GateStep "Required test coverage inventory" $Python @("scripts\verify_quality_coverage.py")
    Invoke-GateStep "Backend test suite" $Python @("-m", "pytest", "-q", "tests")
}
if (Get-Command "npm.cmd" -ErrorAction SilentlyContinue) {
    Invoke-GateStep "Renderer typecheck" "npm.cmd" @("run", "typecheck") (Join-Path $ProjectRoot "apps\desktop\renderer")
    Invoke-GateStep "Renderer production build" "npm.cmd" @("run", "build") (Join-Path $ProjectRoot "apps\desktop\renderer")
    Invoke-GateStep "Electron TypeScript build" "npm.cmd" @("run", "build") (Join-Path $ProjectRoot "apps\desktop\electron")
}
if ($Package) {
    Invoke-GateStep "Clean package and release verification" $PowerShellExecutable @("-NoProfile", "-File", (Join-Path $PSScriptRoot "build-all.ps1"))
    Invoke-GateStep "Packaging security verification" $PowerShellExecutable @(
        "-NoProfile",
        "-File",
        (Join-Path $PSScriptRoot "verify-packaging.ps1"),
        "-InstallerPath",
        (Join-Path $ProjectRoot "apps\desktop\electron\release")
    )
}

$Passed = ($script:Results.Count -gt 0 -and @($script:Results | Where-Object { -not $_.passed }).Count -eq 0)
$Report = [ordered]@{
    schema_version = 1
    generated_at_utc = [DateTime]::UtcNow.ToString("o")
    project_root = $ProjectRoot
    package_requested = [bool]$Package
    passed = $Passed
    gates = $script:Results
}
$Report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8
Write-Host "`nQuality report: $ReportPath"
if ($Passed) {
    Write-Host "QUALITY GATE PASSED" -ForegroundColor Green
    exit 0
}
Write-Host "QUALITY GATE FAILED" -ForegroundColor Red
exit 1
