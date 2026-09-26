#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Back up and reset the NOC AI Assistant database, or restore a reset backup.

.DESCRIPTION
    Recovers a profile whose credentials are lost or whose database is
    corrupted. The script never deletes anything without first copying
    nocai.db, nocai.db-wal and nocai.db-shm to a timestamped backup under
    <DataDir>\backups\db-reset-<UTC timestamp>\ together with a SHA-256
    manifest, so every reset is recoverable with -RestoreFrom. Model and
    knowledge files are never touched.

    Reset mode (default): back up the database files, then delete them. The
    next application start recreates the schema and the first login creates a
    brand-new administrator.

    Restore mode (-RestoreFrom): verify a backup (manifest SHA-256 when
    present), then replace the current database files with the backup files.

.PARAMETER DataDir
    Profile data directory holding nocai.db.
    Defaults to %APPDATA%\NOC AI Assistant.

.PARAMETER RestoreFrom
    Backup directory created by a previous reset (restore mode).

.PARAMETER Force
    Stop running NOC AI Assistant processes that are bound to this profile
    instead of failing. Processes are tree-killed so no backend or llama.cpp
    child is orphaned.

.PARAMETER Yes
    Skip the interactive confirmation prompt (for automation).

.EXAMPLE
    pwsh -NoProfile -File .\scripts\reset-db.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\reset-db.ps1 -Force -Yes

.EXAMPLE
    pwsh -NoProfile -File .\scripts\reset-db.ps1 -RestoreFrom "$env:APPDATA\NOC AI Assistant\backups\db-reset-20260924-120000"
#>
[CmdletBinding(DefaultParameterSetName = 'Reset')]
param(
    [Parameter()]
    [string]$DataDir = (Join-Path $env:APPDATA 'NOC AI Assistant'),

    [Parameter(ParameterSetName = 'Restore', Mandatory = $true)]
    [string]$RestoreFrom,

    [Parameter()]
    [switch]$Force,

    [Parameter()]
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$script:DatabaseFileNames = @('nocai.db', 'nocai.db-wal', 'nocai.db-shm')
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot

function Get-BlockingProcess {
    param([string]$TargetDataDir)

    $targetFull = [System.IO.Path]::GetFullPath($TargetDataDir)
    $blocking = @()
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
        $isBlocking = $false
        $name = $proc.ProcessName
        if ($name -eq 'NOC AI Assistant' -or $name -eq 'nocai-backend') {
            # Packaged application (or legacy standalone backend executable).
            # Only an instance bound to this profile blocks: honour an explicit
            # --data-dir argument, otherwise the instance uses the default
            # %APPDATA%\NOC AI Assistant profile.
            $boundDataDir = $null
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction Stop
                if ($cim.CommandLine) {
                    if ($cim.CommandLine -match '--data-dir(?:\s+|=)"([^"]+)"') {
                        $boundDataDir = $Matches[1]
                    } elseif ($cim.CommandLine -match '--data-dir(?:\s+|=)(\S+)') {
                        $boundDataDir = $Matches[1].Trim('"')
                    }
                }
            } catch { }
            if (-not $boundDataDir) {
                $boundDataDir = Join-Path $env:APPDATA 'NOC AI Assistant'
            }
            try {
                $boundFull = [System.IO.Path]::GetFullPath($boundDataDir)
                if ([string]::Equals($boundFull, $targetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $isBlocking = $true
                }
            } catch { }
        } elseif ($name -eq 'electron') {
            # Development instance of this repository's desktop app only.
            try {
                $exePath = $proc.Path
                if ($exePath -and $exePath.StartsWith($script:ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $isBlocking = $true
                }
            } catch { }
        } elseif ($name -like 'python*') {
            # Backend interpreter: python -m backend.main --data-dir <target>.
            # Generic python processes (tests, editors) are never matched.
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction Stop
                if ($cim.CommandLine -and $cim.CommandLine.Contains('backend.main') -and $cim.CommandLine.Contains($targetFull)) {
                    $isBlocking = $true
                }
            } catch { }
        }
        if ($isBlocking) { $blocking += $proc }
    }
    return $blocking
}

function Stop-BlockingProcess {
    param([array]$Processes)

    if (-not $Processes -or $Processes.Count -eq 0) { return }
    $names = @($Processes | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ', '
    if (-not $Force) {
        throw "NOC AI Assistant is still running ($names). Close it first, or re-run with -Force to stop it."
    }
    Write-Host "Stopping running application processes: $names"
    foreach ($proc in $Processes) {
        # /T terminates the whole tree so backend and llama.cpp children exit too.
        & taskkill.exe /PID ([string]$proc.Id) /T /F 2>$null | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (@(Get-BlockingProcess -TargetDataDir $DataDir).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Application processes did not stop within 15 seconds."
}

function Confirm-DestructiveAction {
    param([string]$Token, [string]$Description)

    if ($Yes) { return }
    if ([Console]::IsInputRedirected) {
        throw "Confirmation is required to $Description. Re-run with -Yes to confirm non-interactively."
    }
    Write-Host $Description
    $answer = Read-Host "Type '$Token' to continue"
    if ($answer -ne $Token) {
        throw "Cancelled: expected '$Token'."
    }
}

function Get-ExistingDatabaseFiles {
    param([string]$TargetDataDir)

    $existing = @()
    foreach ($name in $script:DatabaseFileNames) {
        $path = Join-Path $TargetDataDir $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { $existing += $path }
    }
    return $existing
}

function Copy-DatabaseBackup {
    param([string]$TargetDataDir)

    $existing = @(Get-ExistingDatabaseFiles -TargetDataDir $TargetDataDir)
    if ($existing.Count -eq 0) { return $null }

    $backupRoot = Join-Path $TargetDataDir 'backups'
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $backupDir = Join-Path $backupRoot "db-reset-$stamp"
    $suffix = 1
    while (Test-Path -LiteralPath $backupDir) {
        $backupDir = Join-Path $backupRoot "db-reset-$stamp-$suffix"
        $suffix++
    }
    New-Item -ItemType Directory -Path $backupDir | Out-Null

    $manifestFiles = @()
    foreach ($path in $existing) {
        $name = Split-Path -Leaf $path
        $destination = Join-Path $backupDir $name
        Copy-Item -LiteralPath $path -Destination $destination
        $manifestFiles += [ordered]@{
            name         = $name
            length_bytes = (Get-Item -LiteralPath $destination).Length
            sha256       = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        }
    }
    $manifest = [ordered]@{
        created_utc = [DateTime]::UtcNow.ToString('o')
        data_dir    = $TargetDataDir
        files       = $manifestFiles
    }
    $manifest | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $backupDir 'manifest.json') -Encoding utf8
    return $backupDir
}

function Remove-DatabaseFiles {
    param([string]$TargetDataDir, [string]$BackupDir)

    $deleted = @()
    foreach ($name in $script:DatabaseFileNames) {
        $path = Join-Path $TargetDataDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            Remove-Item -LiteralPath $path -Force
            $deleted += $name
        } catch {
            # Roll back so a partial delete never loses data without a full copy.
            foreach ($done in $deleted) {
                Copy-Item -LiteralPath (Join-Path $BackupDir $done) `
                    -Destination (Join-Path $TargetDataDir $done) -Force
            }
            throw "Could not delete '$name': $($_.Exception.Message) The database was restored from the backup; close any program still using it and retry."
        }
    }
}

function Restore-DatabaseBackup {
    param([string]$TargetDataDir, [string]$SourceDir)

    $sourceFull = [System.IO.Path]::GetFullPath($SourceDir)
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
        throw "Backup directory not found: $sourceFull"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sourceFull 'nocai.db') -PathType Leaf)) {
        throw "Backup directory does not contain nocai.db: $sourceFull"
    }

    $manifestPath = Join-Path $sourceFull 'manifest.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        foreach ($entry in $manifest.files) {
            $sourceFile = Join-Path $sourceFull $entry.name
            if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
                throw "Backup manifest lists a missing file: $($entry.name)"
            }
            $actual = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
            if ($actual -ne $entry.sha256) {
                throw "Backup integrity check failed for '$($entry.name)'; refusing to restore."
            }
        }
    }

    $preRestoreBackup = Copy-DatabaseBackup -TargetDataDir $TargetDataDir
    try {
        # Replace the whole set so an old WAL never pairs with the restored DB.
        foreach ($name in $script:DatabaseFileNames) {
            $current = Join-Path $TargetDataDir $name
            if (Test-Path -LiteralPath $current -PathType Leaf) {
                Remove-Item -LiteralPath $current -Force
            }
        }
        foreach ($name in $script:DatabaseFileNames) {
            $sourceFile = Join-Path $sourceFull $name
            if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
                Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $TargetDataDir $name)
            }
        }
    } catch {
        $hint = ''
        if ($preRestoreBackup) { $hint = " The previous database was backed up to: $preRestoreBackup" }
        throw "Restore failed: $($_.Exception.Message)$hint Original backup remains at: $sourceFull"
    }
    return $preRestoreBackup
}

try {
    $DataDir = [System.IO.Path]::GetFullPath($DataDir)
    $isRestore = ($PSCmdlet.ParameterSetName -eq 'Restore')

    if ($isRestore) {
        $RestoreFrom = [System.IO.Path]::GetFullPath($RestoreFrom)
        # Validate before touching anything.
        if (-not (Test-Path -LiteralPath $RestoreFrom -PathType Container)) {
            throw "Backup directory not found: $RestoreFrom"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $RestoreFrom 'nocai.db') -PathType Leaf)) {
            throw "Backup directory does not contain nocai.db: $RestoreFrom"
        }
        Confirm-DestructiveAction -Token 'RESTORE' `
            -Description "restore the database in '$DataDir' from '$RestoreFrom'"
        if (-not (Test-Path -LiteralPath $DataDir)) {
            New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        }
        Stop-BlockingProcess -Processes @(Get-BlockingProcess -TargetDataDir $DataDir)
        $preBackup = Restore-DatabaseBackup -TargetDataDir $DataDir -SourceDir $RestoreFrom
        Write-Host "Restored database files from: $RestoreFrom"
        if ($preBackup) { Write-Host "Database that was replaced was backed up to: $preBackup" }
        Write-Host "Start NOC AI Assistant to sign in with the restored credentials."
        exit 0
    }

    $existing = @(Get-ExistingDatabaseFiles -TargetDataDir $DataDir)
    if ($existing.Count -eq 0) {
        Write-Host "No database files found in '$DataDir'; nothing to reset."
        exit 0
    }

    Confirm-DestructiveAction -Token 'RESET' `
        -Description "back up and delete the database in '$DataDir' (conversations, audit history and accounts move to the backup; model and knowledge files are untouched)"
    Stop-BlockingProcess -Processes @(Get-BlockingProcess -TargetDataDir $DataDir)

    $backupDir = Copy-DatabaseBackup -TargetDataDir $DataDir
    Remove-DatabaseFiles -TargetDataDir $DataDir -BackupDir $backupDir

    Write-Host "Backed up database to: $backupDir"
    Write-Host "Deleted: $($script:DatabaseFileNames -join ', ')"
    Write-Host "Start NOC AI Assistant; the first login creates a fresh administrator."
    Write-Host "To undo this reset: pwsh -NoProfile -File `"$PSCommandPath`" -RestoreFrom `"$backupDir`""
    exit 0
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
}

