# NOC AI Assistant engineering harness

You are working on the Windows desktop application in this repository. Read
`NEMOTRON_FINAL_REMEDIATION_PROMPT.md` before changing code and treat its
definition of done as binding.

## Required working loop

1. Inspect the current implementation and reproduce a failure before changing it.
2. Implement the smallest coherent fix, including a regression test.
3. Use the `quality-gate` tool (or run `./scripts/quality-gate.ps1`) from the
   repository root.
4. Read `.artifacts/nemotron/quality-report.json` and fix every failed gate.
5. Repeat until the gate exits 0. A written explanation is not a substitute for
   passing verification.

## Safety and truthfulness

- Never read, modify, reset, or test against the real `%APPDATA%\NOC AI Assistant`
  profile. Use isolated temporary profiles, databases, ports, and credentials.
- Preserve user data and models. Never weaken Defender, Smart App Control, UAC,
  Electron isolation, authentication, or signing controls.
- Never expose tokens, passwords, certificate material, environment secrets, or
  document contents in output, logs, tests, or commits.
- Do not turn failures into fake success with stubs, empty responses, hard-coded
  health, swallowed exceptions, disabled tests, or reduced assertions.
- Do not edit generated copies in `backend/build`, packaged output, or `dist` as
  the source of a fix. Change authoritative source and rebuild it.
- Use PowerShell-compatible commands on Windows. Use the repository `.venv`
  rather than an untracked global Python environment.
- Keep processes bounded. Stop child processes started by tests and never leave
  backend, Electron, or llama.cpp processes orphaned.
- If an external prerequisite is genuinely missing, give the exact failed gate,
  sanitized evidence, and reproduction command. Do not describe unfinished work
  as complete.

## Completion standard

The task is complete only when the independent quality gate passes. For a release,
also run `./scripts/quality-gate.ps1 -Package`; signed releases additionally need
the user-owned signing certificate described in the remediation prompt.
