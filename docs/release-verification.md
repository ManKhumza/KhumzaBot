# Windows release verification

This is a procedure and result template, not a claim that its cases passed. Record results against one build ID and artifact hash. Use [build-guide.md](build-guide.md) for prerequisites and current commands and [NEMOTRON_FINAL_REMEDIATION_PROMPT.md](../NEMOTRON_FINAL_REMEDIATION_PROMPT.md) for completion requirements.

## Automated evidence

From a prepared repository root:

```powershell
.\scripts\quality-gate.ps1 -Package -SoakMinutes 60
```

Require exit 0 and inspect `.artifacts/nemotron/quality-report.json`. Preserve the report and referenced gate logs before another run overwrites them. Record the generated timestamp, package/soak options, each result, and source/build identity. Retain desktop workflow resource snapshots and elapsed time with the release evidence. Do not infer a 60-minute run from a test name or from the short two-cycle CI variant.

For the command above, the extended duration applies to the packaged workflow; source desktop checks use the short CI cycles. Each completed cycle updates `workflow-resource-snapshots.json` under `.artifacts/desktop-tests`. Confirm at least 60 minutes of workflow elapsed time and inspect every recorded threshold result.

The automated desktop tests use temporary synthetic profiles and exercise onboarding, sign-in errors, forced password change, navigation, restore confirmation, actual bundled BGE ingestion/retrieval, cited local chat, backend restart persistence, process cleanup, backend death, renderer crash, and concurrent restarts. Read the current [desktop tests](../apps/desktop/electron/e2e) for exact assertions. The workflow monitors process count, handles, threads, memory and log size; the backend suite also checks database locking/integrity and bounded resources.

The package gate launches `apps/desktop/electron/release/win-unpacked/NOC AI Assistant.exe`. This validates packaged application behavior, but leaves the actual installer, portable launcher, Windows elevation behavior, shortcuts/registration, upgrade, and uninstall to the lifecycle cases below. Do not label unpacked-app execution as a completed installer test.

## Artifact and signature record

Use current output from `apps/desktop/electron/release/RELEASE-INFO.json` and `SHA256SUMS.txt`, then independently verify it:

```powershell
.\scripts\verify-packaging.ps1 -InstallerPath apps/desktop/electron/release
.\.venv\Scripts\python.exe scripts/release_integrity.py --release apps/desktop/electron/release
Get-ChildItem -LiteralPath apps/desktop/electron/release -File -Filter '*.exe' |
    ForEach-Object {
        [pscustomobject]@{
            Name = $_.Name
            Bytes = $_.Length
            SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            Authenticode = (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status.ToString()
        }
    }
```

Record version, build ID, source revision or source-manifest identity, distribution label, filenames, byte sizes, SHA-256 values, and signature status. Expected primary outputs are `NOC-AI-Assistant-Setup-<VERSION>.exe` and `NOC-AI-Assistant-Portable-<VERSION>.exe`; the portable artifact is an executable.

For a requested signed release:

```powershell
.\scripts\verify-packaging.ps1 -InstallerPath apps/desktop/electron/release -RequireSignature
```

The signing setup and missing-certificate behavior are documented in the build guide. An unsigned development build may pass the ordinary package gate. It must remain labeled unsigned and must not be reported as an approved signed distribution. Record valid installed app, embedded runtime, and uninstaller signatures during signed lifecycle verification.

## Isolated Windows lifecycle checklist

Use a disposable Windows VM or equivalent isolated test installation with a dedicated standard user account and no existing NOC AI Assistant data. The entire Windows user profile must belong to the disposable test environment. Never run install, upgrade, uninstall, or reset cases against the developer's real `%APPDATA%\NOC AI Assistant` profile. Use synthetic documents, fresh credentials, and locally supplied test models. Keep Windows security features enabled.

Record Windows version, account type, architecture, security settings, build ID and Setup/Portable hashes before each run. Do not claim a Windows version was tested because it appears in a checklist. Record each result as **Pass**, **Fail**, **Blocked**, or **Not run**, with a timestamp and sanitized evidence location.

| Case | Procedure and required evidence | Result |
| --- | --- | --- |
| Per-user installation | Run Setup through the normal per-user route from the standard account. Verify installation completes without Administrator/UAC elevation, the selected destination contains the app, and requested Start Menu/Desktop shortcuts point to it. The configuration uses `perMachine: false` and `requestedExecutionLevel: asInvoker`; configuration alone is not this test. | Not run |
| First launch | Launch the installed shortcut. Verify a usable onboarding screen, responsive UI, a ready local backend and bundled embedding runtime, and no console windows or secret-bearing errors. | Not run |
| Administrator creation | Create a local administrator in the onboarding form with a fresh password meeting the displayed policy. There are no assumed/default credentials. Test sign-out, wrong-password error and successful sign-in. Do not record credentials. | Not run |
| Navigation | Open Chats, Knowledge, Search, Models, Settings, Diagnostics, and every visible administrator/menu route. Verify one usable application shell, readable failures, and no blank screens or silent actions. | Not run |
| Local model and chat | Import a compatible local chat GGUF, activate it, obtain a nonempty completion through the visible composer, then cancel another generation. Verify truthful model/generation state and useful errors after a runtime failure. | Not run |
| Ingestion and retrieval | Upload synthetic TXT, CSV, HTML, DOCX and PDF documents. Observe durable jobs, progress, positive chunk counts and ready status. Search for fixture content, verify source metadata and cited chat context. Check corrupt/empty input produces an actionable failure and retry/cancel work. | Not run |
| Settings, sessions and restart | Change a setting and create a conversation. Close and relaunch, sign in as required, and verify settings, messages and source data persist. Verify reported model readiness matches actual runtime recovery. | Not run |
| Backup and restore | Back up synthetic data, change it, and restore through the explicit UI confirmation. Verify restored state and rejection of an invalid archive. Retain a verified backup before destructive lifecycle cases. | Not run |
| Recovery and diagnostics | Terminate only test-owned backend, llama.cpp and renderer processes in controlled cases. Verify bounded recovery, sanitized diagnostics, responsive navigation, preserved records and no duplicate children. | Not run |
| Close and reboot | Close normally and verify the app's backend/llama.cpp descendants exit. Reboot the disposable VM, relaunch and verify persistence and runtime health. | Not run |
| Upgrade from prior release | Restore a clean VM snapshot, install the actual prior release, create synthetic users/documents/chats/settings and retain a backup. Close it, install this release over it and verify the same data remains usable, migrations complete, and resources/version reflect this build. Record both installer hashes. | Not run |
| Uninstall with preservation | Close the app and run its installed uninstaller. Verify app files, shortcuts and registration are removed, no owned children remain, and synthetic user data/models are preserved by default. Reinstall and verify the preserved data is usable. | Not run |
| Explicit data removal | In a separate disposable snapshot with a verified backup, test only an explicitly offered/supported removal action and verify its scope and confirmation. Current builder configuration does not include the legacy `installer.nsh` data-removal checkbox; do not claim that checkbox is available. | Not run |
| Portable launcher | Launch the actual Portable executable in the disposable standard account, repeat onboarding/local embedding/chat/close checks, and confirm no owned backend/llama.cpp processes remain. Do not substitute `win-unpacked` for this case. | Not run |
| Offline use | Disconnect only the disposable test machine's network after dependencies/models are available, repeat local workflows, and verify observed traffic is limited to expected loopback services. Keep Defender, Smart App Control, UAC, and application isolation enabled. | Not run |
| Signed distribution | When signing is requested, verify Authenticode status of the installed app, executable runtime dependencies, installer and installed uninstaller; verify the standard-user install/launch route with Windows security enabled. | Not run |

The active NSIS configuration preserves app data by default. Electron builder's stock uninstaller recognizes an explicit `--delete-app-data` option; that is not evidence of a visible confirmation workflow or tested recovery. Do not run it on a real user profile. Legacy `test-version-1.0.5-installation.ps1`, `verify-installer-status.ps1`, and `final-installer-check.ps1` do not establish lifecycle results.

## Release decision

Publish a concise report of fixes and migrations, exact commands and pass/fail results, current artifacts and signatures, completed manual cases, and unresolved prerequisites. A missing user-owned production signing certificate can block a signed release; record the exact signing preflight failure without exposing certificate material. Unexecuted lifecycle or soak cases remain incomplete verification and must not be relabeled as external blockers or successful results.
