# Windows build and verification

Run commands below from the repository root in a normal PowerShell session. The authoritative entry points are [build-all.ps1](../scripts/build-all.ps1) for preparation and packaging and [quality-gate.ps1](../scripts/quality-gate.ps1) for independent verification. Building an installer does not establish that installation, upgrade, or uninstall passed; record those results separately using [release-verification.md](release-verification.md).

## Prerequisites

- Windows x64 with an interactive desktop for Electron end-to-end tests.
- Node.js 22.12.0 or newer, required by the pinned Electron dependency, with `npm.cmd` available.
- Python 3.11 or newer to create the repository `.venv`; all subsequent Python development commands use that environment.
- PowerShell; PowerShell 7 is recommended.
- Network access for initial npm/pip dependencies and official runtime downloads. Application workflows use local services and models.
- The bundled `resources/models/bge-small-en-v1.5-q8_0.gguf` and its attribution file. Its required SHA-256 is `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804`.
- A compatible, locally supplied GGUF chat fixture for the real desktop workflow. Set `NOC_AI_CHAT_TEST_MODEL` to its absolute path. The current fallback is `resources/models/Qwen3-4B-Q4_K_M.gguf`; a missing fixture fails the desktop test explicitly. The fixture is not included in release packages.

For a fresh checkout, prepare dependencies and runtimes before the independent gate:

```powershell
.\scripts\build-all.ps1 -SkipPackaging
```

Set a chat fixture only when the fallback file is absent or another compatible local model is intended:

```powershell
$env:NOC_AI_CHAT_TEST_MODEL = 'C:\TestModels\compatible-chat.gguf'
```

The supplied path must exist. Choose a small model that can complete on the test machine within the workflow's bounded timeouts. Do not use the real `%APPDATA%\NOC AI Assistant` profile, existing credentials, or private documents as fixtures. The automated desktop harness creates temporary profiles and strips inherited application secrets and profile overrides.

CI uses Node 24 and the same preparation command. Its runner must have the local chat fixture provisioned before verification; the `NOC_AI_CHAT_TEST_MODEL` repository variable selects its path. A standard hosted runner without that fixture fails the prerequisite check explicitly.

## Verify and package

Run the independent development gate after preparation:

```powershell
.\scripts\quality-gate.ps1
```

For release verification, rebuild the package, test its executable, and run the required extended workflow soak:

```powershell
.\scripts\quality-gate.ps1 -Package -SoakMinutes 60
```

The gate records results in `.artifacts/nemotron/quality-report.json` and logs in its sibling `gate-logs` directory. Check the exit code, report generation time and requested options, and every gate result. A historical passing report is not evidence for newer source or artifacts. `-ReportPath` can preserve a separate run's report and logs. A release requires all gates to pass and the Windows lifecycle results in the release checklist.

The gate checks resource integrity and security configuration, Python compilation and required coverage inventory, the backend suite, renderer typecheck/build, Electron TypeScript build, and real desktop workflows. `-Package` additionally invokes the clean build, package verification, and workflows against `release/win-unpacked/NOC AI Assistant.exe`. The packaged workflow uses the embedded backend and bundled BGE resource. It does not run the NSIS installer or portable launcher.

With `-Package -SoakMinutes 60`, source desktop checks use the short CI cycles and the packaged workflow runs the 60-minute soak. Without `-Package`, the requested soak duration applies to source desktop checks. Resource snapshots are written as `workflow-resource-snapshots.json` under `.artifacts/desktop-tests`; preserve them before the next Playwright run.

To produce unsigned development artifacts directly:

```powershell
.\scripts\build-all.ps1
```

`build-all.ps1` refreshes the embedded Python backend from authoritative source even when the base interpreter is cached. It installs constrained Python dependencies and locked npm dependencies, builds both desktop projects, clears only the dedicated release output, packages, then generates and verifies checksums and the release manifest. Runtime versions and archive hashes are pinned in [runtime-lock.json](../resources/runtime-lock.json). Do not patch `backend/build`, `dist`, `runtimes/python/Lib/site-packages/backend`, or packaged files as a source fix.

`VERSION` is authoritative. Package metadata, lockfile roots, backend package/API version, and artifact filenames must agree with it. Do not use the build script's skip switches as evidence of a clean release.

## Release outputs and integrity

Artifacts are under `apps/desktop/electron/release`:

| File | Purpose |
| --- | --- |
| `NOC-AI-Assistant-Setup-<VERSION>.exe` | NSIS installer |
| `NOC-AI-Assistant-Portable-<VERSION>.exe` | Portable launcher |
| `SHA256SUMS.txt` | Checksums generated after packaging/signing |
| `RELEASE-INFO.json` | Version, build ID, distribution label, source and package hashes, artifact sizes |
| `win-unpacked/` | Packaged application used by automated desktop verification |

The package contains the embedding model, embedded Python, and llama.cpp. It does not bundle a chat model. Check a finished unsigned build with:

```powershell
.\scripts\verify-packaging.ps1 -InstallerPath apps/desktop/electron/release
.\.venv\Scripts\python.exe scripts/release_integrity.py --release apps/desktop/electron/release
```

The integrity checker rejects unexpected or mixed-version executable artifacts, stale checksums, missing resources, a stale packaged backend, and source/package differences from the manifest. Keep the manifest and verification report with distributed artifacts. Do not regenerate the manifest just to conceal an unexplained mismatch.

## Signed release

Unsigned output is labeled `unsigned-development`. A signed release requires a user-owned, trusted code-signing certificate with an accessible private key. Keep Windows security enabled and use an appropriately trusted certificate for the intended distribution.

Configure either `NOC_AI_CERT_THUMBPRINT` for a certificate available through the Windows certificate store, or `NOC_AI_CERT_PFX` and `NOC_AI_CERT_PASSWORD` for a user-supplied PFX. Supply passwords through the process environment without putting them in source, scripts, logs, or command arguments. Do not configure both certificate methods.

```powershell
.\scripts\sign-windows.ps1 -Preflight
.\scripts\build-all.ps1 -Sign
.\scripts\verify-packaging.ps1 -InstallerPath apps/desktop/electron/release -RequireSignature
```

The preflight fails if signing material is unavailable or unsuitable. The signing script preserves existing valid signatures and signs remaining EXE, DLL, and PYD files; the Electron builder hook also signs the app, installer, and uninstaller. Verification with `-RequireSignature` requires valid Authenticode status for all enumerated code files. Timestamping requires access to the configured timestamp service.

The signed build produces new artifacts and hashes. Repeat packaged desktop smoke verification for those artifacts, retain signature results, and verify the installed uninstaller in the disposable Windows lifecycle test. `quality-gate.ps1 -Package` builds unsigned development output; do not run it over completed signed artifacts and report the result as signed verification.

## Focused diagnosis

These commands help reproduce a failure; they do not replace the full gate:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests
npm.cmd run typecheck --prefix apps/desktop/renderer
npm.cmd run build --prefix apps/desktop/renderer
npm.cmd run build --prefix apps/desktop/electron
npm.cmd run test:e2e --prefix apps/desktop/electron
```

Electron uses its `build` script for TypeScript checking. Read the failing gate's log, reproduce against an isolated profile, fix authoritative source with a regression test, and rerun the gate. Record a missing external prerequisite with the exact failed command and sanitized error.
