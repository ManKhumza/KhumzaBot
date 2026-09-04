# Nemotron/OpenCode quality harness

The repository now gives the `nemotron-builder` agent full OpenCode tool access,
including a dedicated `quality-gate` tool, and independently checks its changes.
Agent permission and Windows elevation are
different controls: `opencode.jsonc` grants tools, while the PowerShell process
token determines whether commands may change protected machine locations.

## Run it

From a normal PowerShell 7 window in the repository root:

```powershell
.\scripts\nemotron-harness.ps1
```

The harness creates a uniquely named OpenCode session, runs Nemotron, executes
the build/test gate, and feeds the JSON failure report back into the same session
for up to five rounds. Logs and the session ID are stored under
`.artifacts\nemotron\runs`; the current gate result is
`.artifacts\nemotron\quality-report.json`.

The gate also enforces a minimum test inventory across the risk areas named in
the remediation prompt. This prevents a three-test smoke suite from being
mistaken for professional-grade coverage; the tests must both exist and pass.

To require a fresh installer after the ordinary gate passes:

```powershell
.\scripts\nemotron-harness.ps1 -MaxRounds 8 -PackageOnPass
```

In the interactive OpenCode UI, `/finish` applies the same agent instructions.
You can also run the independent check yourself with:

```powershell
.\scripts\quality-gate.ps1
```

## System-level changes

Only use elevation when a task genuinely must modify a protected Windows path,
service, certificate store, firewall rule, or installed application. The switch
requests a standard UAC consent prompt and relaunches the harness with an
administrator token:

```powershell
.\scripts\nemotron-harness.ps1 -Elevated
```

This is intentionally explicit. Repository edits, builds, tests, and per-user
installation should work without elevation. Full OpenCode permission cannot
bypass Windows access control, and elevation cannot fix an overloaded NVIDIA
model endpoint. Transient 503/capacity failures are detected and retried while
preserving the same OpenCode session.

Validate configuration without calling the model:

```powershell
.\scripts\nemotron-harness.ps1 -PreflightOnly
opencode debug agent nemotron-builder
```
