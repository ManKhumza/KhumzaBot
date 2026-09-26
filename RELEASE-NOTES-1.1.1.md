# NOC AI Assistant 1.1.1 release notes

## Fixed: chat returned "Internal Server Error" instead of an answer from the knowledge base

### What users saw

Sending a chat message failed with one of:

- `Error invoking remote method 'nocai:chat:sendMessage': Error: Internal Server Error`
- `Error invoking remote method 'nocai:chat:sendMessage': TypeError: fetch failed`

No assistant message was stored, and the knowledge base appeared to be ignored.

### Root cause

Retrieval was working. Against the reported profile, `POST /api/v1/knowledge/search`
returned scored hits for the same questions. The failure was in the step after
retrieval:

1. `POST /api/v1/chat/completions` never sent a `max_tokens` value to the local
   llama.cpp runtime for a conversation that carried no explicit response length,
   so the runtime generated until the model context window was exhausted.
2. On the reported machine (4 CPU cores, no GPU offload) one bounded grounded
   answer took **453 seconds** to first complete. The backend's local runtime
   client gave up after **300 seconds** and raised `httpx.ReadTimeout`.
3. An unhandled `httpx.ReadTimeout` reached FastAPI, which answered with the bare
   `500 Internal Server Error` body shown in the UI and stored no assistant
   message.

The desktop bridge's own 180-second abort made the same request fail even earlier
when the model was already warm.

### What changed

- The backend now always sends an explicit, bounded `max_tokens`. The resolved
  limit is the smallest of the request value, the conversation value, a
  2048-token hard cap, and the room left inside the model context window after
  the prompt is estimated.
- The local chat runtime request limit is now
  `NOC_AI_CHAT_GENERATION_TIMEOUT_SECONDS` (default `3600`), separate from the
  embedding request limit (default `300`). A fully offline CPU model is allowed
  to finish.
- Model startup readiness now allows `NOC_AI_MODEL_LOAD_TIMEOUT_SECONDS`
  (default `180`) instead of 60 seconds, because loading multi-gigabyte weights
  from disk on a busy machine routinely exceeded the old budget.
- A local runtime timeout now returns HTTP `503` with an actionable message
  instead of an opaque `500`, so the chat view explains what to do: shorten the
  question or the response length, choose a smaller model, or raise the limit.
- The desktop bridge waits longer than the backend's own deadline, so the
  backend's explanation is what the user sees.
- `llama-server` discovery no longer depends on the process working directory.
  The bundled runtime beside the application resources and the repository
  `runtimes/llama` location are both found, and the error names
  `NOC_AI_LLAMA_SERVER_PATH`.
- Database encryption migration now folds the SQLite write-ahead log in before
  exporting, backs the `-wal`/`-shm` sidecars up with the database, verifies the
  encrypted copy, and removes stale plaintext sidecars. The reported profile had
  a 5 MB `nocai.db-wal`.

### Verification

- `tests/test_chat_generation_limits.py` (new) covers the bounded limit, the
  context-window clamp, the `503` conversion, the preserved model HTTP status,
  the requested time budgets, and conversation consistency after a timeout.
- `tests/test_security.py` covers write-ahead-log preservation and plaintext
  sidecar removal during encryption migration.
- The desktop renderer-crash recovery test now injects a real renderer loss
  deterministically: if Chromium declines the forced crash while the automation
  debugger owns the target, the original renderer process is terminated instead.
  The test passed five consecutive runs after the change.
- Against a copy of the reported profile with the reported questions, both
  requests now return HTTP `200` with non-empty grounded answers and citations
  drawn from the indexed documents.
- `scripts/quality-gate.ps1 -Package` passes for this build.

### Notes for this build

- The installer is unsigned. Windows may show a SmartScreen or Smart App Control
  warning; that is expected for an internal build.
- The first launch of this version migrates the existing plaintext database to
  SQLCipher. A backup of the original database is written next to it as
  `nocai.db.bak` and is kept.
- One grounded answer on CPU-only hardware can take several minutes. The chat
  view stays in its "Generating response..." state and `Stop` remains available
  the whole time.
