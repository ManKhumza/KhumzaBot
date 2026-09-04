# Qwen Code Project Instructions

NOC AI Assistant is an offline Windows desktop application built with Electron,
React, FastAPI, SQLite, and llama.cpp.

Read `AGENTS.md` and `NEMOTRON_FINAL_REMEDIATION_PROMPT.md` before proposing or
making changes. The remediation prompt's definition of done is binding.

## Working rules

- Start with a read-only assessment unless the user explicitly asks for a fix.
- Never read, modify, or test against `%APPDATA%\NOC AI Assistant`; use an
  isolated temporary profile, database, ports, and credentials.
- Do not expose secrets, credentials, certificates, tokens, document contents,
  or user data in output, logs, prompts, or patches.
- Preserve Electron isolation and sandboxing, authentication, signing, and
  Windows security controls. Do not add cloud calls, telemetry, or remote model
  dependencies.
- Change authoritative source only; never edit `backend/build`, `dist`, or
  packaged output as the source of a fix.
- Before changing code, reproduce the failure. Make the smallest coherent fix
  with a regression test. Do not replace failures with stubs, hard-coded health,
  suppressed errors, or weaker assertions.
- After a code change, run `./scripts/quality-gate.ps1` from the repository
  root, read `.artifacts/nemotron/quality-report.json`, and resolve every failed
  gate before reporting completion.

## Useful checks

```powershell
.\scripts\quality-gate.ps1
```

Use the repository `.venv` for Python. Keep test processes bounded and clean up
any Electron, backend, or llama.cpp child processes that tests start.
