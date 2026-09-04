# Nemotron Ultra prompt: finish and harden NOC AI Assistant

You are the senior engineer responsible for taking this repository from a partially working prototype to a reliable, installable Windows desktop application. Work directly in the current repository and implement the fixes; do not stop after analysis or merely write a plan.

The product is **NOC AI Assistant**, an offline Electron + React + FastAPI desktop application using llama.cpp and GGUF models. It must install and run on Windows without requiring the user to disable Windows security features or launch the application as Administrator.

## Operating rules

1. Preserve all existing user data and models. Never delete or mutate the real `%APPDATA%\NOC AI Assistant` profile while testing. Use isolated temporary data directories and databases for automated and packaging tests.
2. Do not weaken Smart App Control, Defender, UAC, authentication, Electron sandboxing, context isolation, or TLS/code-signing controls. Fix the application and release pipeline instead.
3. Do not paper over failures with hard-coded `healthy` values, empty arrays, fake success responses, swallowed exceptions, placeholder data, or disabled tests.
4. Keep the app local/offline by default. Do not add cloud calls, telemetry, analytics, or remote model dependencies.
5. Never hard-code or print passwords, bearer tokens, backend secrets, certificate passwords, or other credentials. Redact secrets in logs and error reports.
6. Prefer one coherent implementation over maintaining broken legacy and live service layers in parallel. Remove dead code only after proving it has no callers.
7. Preserve the bundled embedding model and its attribution:
   - `resources/models/bge-small-en-v1.5-q8_0.gguf`
   - expected SHA-256: `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804`
   - it produces 384-dimensional embeddings.
8. A signing certificate/private key is an external prerequisite. Make unsigned developer builds possible, but clearly label them; make signed release builds fail clearly if signing was requested and a certificate is unavailable.

## Baseline facts found in the final audit

Verify each fact yourself before changing it, then fix the underlying design.

### Evidence captured from the running installed application

Treat these as concrete reproduction evidence, not hypotheses:

- The installed application was running from `C:\Program Files\NOC AI Assistant` with its embedded Python backend on loopback, but **no llama.cpp process was alive**, despite both chat and embedding models being marked `active` in the database.
- The live user database contained one uploaded document still at `queued`, with `chunk_count = 0`; the `ingestion_jobs` table contained zero rows. Do not inspect or expose user document contents during remediation.
- The live database marked both the chat and embedding models `active` while neither had a running llama.cpp process. Treat this database/runtime split-brain state as a consistency defect and repair it automatically on startup.
- A clean temporary-profile API test reproduced the defect: collection creation succeeded, upload returned HTTP 200 with `status="queued"` and zero chunks, `GET /api/v1/jobs` returned HTTP 200 with `[]`, and knowledge search returned HTTP 200 with `[]`.
- Directly launching the packaged llama.cpp runtime with the installed `SmolLM2-135M-Instruct-Q4_K_M.gguf` reached healthy state and returned a nonempty chat completion. The GGUF and llama.cpp binary therefore work; the application orchestration is the failing layer.
- `ModelLifecycleManager._start_llama_server()` refers to an undefined local variable named `role`. Calling the real lifecycle manager deterministically raises `NameError: name 'role' is not defined` before it can start llama.cpp. Use `provider.role` or pass a strongly typed role explicitly, then add a regression test that would have caught this.
- The same direct llama.cpp test warned that legacy `--mlock` is deprecated, Windows `VirtualLock` failed, all CORS origins were allowed, and no llama.cpp API key was configured. Use current supported flags, conservative Windows defaults, loopback binding, and defense in depth for the local inference endpoint.
- The backend process startup secret appeared in the Windows process command line because Electron passed it as `--token ...`. Move it to a protected inherited environment variable or another non-command-line mechanism, redact it everywhere, and test that process inspection and logs do not reveal it.
- No application-owned persistent diagnostic log or crash dump was found under the product data/profile directories. No matching Windows Application Error event was present during the inspected seven-day window. This does **not** disprove the reported instability: deterministic exceptions, backend exits, blank/unresponsive renderer states, or silently restarted children are currently not captured well enough to classify. Add observability before claiming crash fixes.
- The live database contained 12 unrevoked, unexpired sessions after repeated sign-ins, and no logout audit action. Verify session cleanup, logout revocation, expiry cleanup, forced-password-change behavior, and a sensible limit/revocation policy per user/device.
- Audit rows were present, but their metadata was `{}` and actor fields were unset for observed login records. `audit_log()` passes `metadata=...` while the mapped ORM property is `audit_metadata`; repair the mapping/call and verify sanitized context and actor attribution are actually persisted.
- The backend import sweep found 40 first-party modules, of which six failed to import:
  - `backend.chat.context`: undefined `SearchResult`
  - `backend.documents.pipeline`: nonexistent `Database`
  - `backend.documents.service`: nonexistent `Database`
  - `backend.knowledge.preview`: nonexistent `Database`
  - `backend.models.service`: nonexistent `ModelInfo`
  - `backend.retrieval.service`: nonexistent `Database`
- The isolated backend reported that `sqlite_vec` was unavailable and skipped vector table creation while still completing startup. A professional build must either package and load its required vector capability or expose a clear degraded/not-ready state; it must never advertise operational RAG when the vector store is absent.

### P0: renderer, preload, Electron, and API contracts disagree

- `apps/desktop/preload/preload.ts` invokes `nocai:chat:stopGeneration`, but `apps/desktop/electron/main.ts` has no matching IPC handler.
- Preload sends `renameConversation(id, title)` as two positional arguments, while Electron destructures one `{ id, title }` object.
- Electron sends `PATCH /api/v1/chat/conversations/{id}` with `{title}` in the JSON body, while the FastAPI route currently treats `title` as a query parameter.
- Electron invokes `/api/v1/knowledge/documents/{id}/reprocess`, but the backend exposes no such route.
- Electron calls `/admin/shutdown`, but the backend exposes no shutdown route. Implement a safe authenticated local shutdown mechanism or remove this HTTP dependency and terminate the owned child process gracefully.
- `nocai:system:getVersion` is typed as `Promise<string>` but currently returns health JSON.
- The backend error banner's close control restarts the backend instead of dismissing the banner.
- `ChatView.tsx` deliberately substitutes an empty message list instead of loading stored messages.
- Create an automated IPC/API contract test or shared typed contract so every exposed preload method has exactly one compatible Electron handler and, where applicable, one compatible backend route. Cover argument shape, HTTP method, URL, request body/query, response type, and error type.

### P0: knowledge ingestion and retrieval are not implemented end to end

- Uploading a document copies it and marks it `queued`, but does not reliably create and execute an ingestion job.
- `backend/knowledge/routes.py` and `backend/retrieval/routes.py` return unconditional empty search results.
- `backend/jobs/routes.py` returns an empty list and retry/cancel return success without doing the operation.
- `backend/documents/pipeline.py`, `backend/documents/service.py`, `backend/knowledge/preview.py`, and `backend/retrieval/service.py` import a nonexistent `Database` abstraction and do not match the live SQLAlchemy `Session` architecture.
- `backend/chat/context.py` fails import because `SearchResult` is undefined.
- `backend/models/service.py` imports `ModelInfo`, which does not exist in `backend.models.routes`.
- The vector schema has been hard-coded for 768 dimensions in places, but the bundled BGE model returns 384 dimensions. Dimension must be derived from the active embedding model and validated consistently; migration must safely handle an existing incompatible index without losing source documents.
- Inspect `backend/retrieval/vector_store.py`: SQL placeholder ordering appears inconsistent when collection/document filters are present, and it uses a mutable default argument.
- Complete the real flow: upload -> durable job -> parse -> normalize -> chunk -> embed -> persist vectors/metadata -> mark ready -> semantic search -> source metadata/citations -> optional retrieval context in chat.
- Support the file formats already advertised by the UI/backend. Unsupported, scanned, corrupt, encrypted, or empty documents must produce a visible actionable failure state, not false success.
- Jobs must have durable states, progress, error messages, retry semantics, cancellation semantics, and cleanup behavior. App restart must recover or safely mark interrupted work.

### P0: local transport authentication is not actually enforced

- Electron now distinguishes a backend bootstrap secret from a user login session, but FastAPI middleware only checks that an `Authorization` header starts with `Bearer`; it does not compare the transport secret with `NOC_AI_SESSION_TOKEN`.
- Implement two separate authentication layers:
  1. an unguessable per-process backend transport secret, passed by Electron in a dedicated header such as `X-NOC-AI-Backend-Token` on every proxied request and compared in constant time with `hmac.compare_digest`; and
  2. the logged-in user's session token in `Authorization: Bearer ...` for user identity and permissions.
- Do not expose the backend transport secret to renderer JavaScript and do not log the spawned backend command line or environment secrets.
- Health/liveness used before login may omit user auth, but must still require the transport secret unless there is a narrowly justified loopback-only bootstrap check.
- Reassess CORS. `allow_origins=["http://127.0.0.1:*", "file://"]` is not a valid wildcard-origin policy. Prefer IPC-only access; otherwise use an exact allowlist or a narrowly scoped origin regex.
- Restrict navigation, new windows, `shell.openExternal`, and `shell.openPath` to explicitly allowed protocols and validated paths. Keep `contextIsolation: true`, sandboxing enabled where compatible, and Node integration disabled in the renderer.

### P0: model runtime and chat are not proven operational

- A real request using `SmolLM2-135M-Instruct-Q4_K_M.gguf` returned HTTP 500 and the llama.cpp child did not remain alive. Capture and persist bounded stdout/stderr, exit code, command configuration with secrets redacted, health timeout, and the last useful error so the UI explains why loading failed.
- Fix the confirmed undefined-`role` lifecycle exception first and add a focused test that launches both chat and embedding roles through `ModelLifecycleManager`, not only by calling llama.cpp directly.
- Drain both child-process streams to avoid pipe deadlocks. Store local rotating logs under the application log directory.
- `ModelLifecycleManager.startup()` is a no-op. Reconcile database state with actual child processes on launch; do not report a model loaded merely because a database flag is set.
- Do not ignore a failed runtime health check. Loading/activation must be transactional and must roll back state on failure.
- Use role-specific llama.cpp arguments. Embedding models need `--embedding` and the correct pooling; chat models must not receive embedding-only flags.
- Treat `--mlock`, GPU layer count, threads, context size, ports, timeouts, and memory limits as validated platform-aware settings. Provide a conservative CPU fallback on Windows.
- Protect the loopback llama.cpp server against unrelated local/web-origin callers. Use the runtime's supported API-key capability or an equally strong per-process control, disable permissive CORS, and never expose the key to the renderer or logs.
- Implement generation cancellation through all layers, including cleanup when the window closes or the user navigates away.
- Prove both:
  1. bundled BGE `/v1/embeddings` produces a finite 384-element vector; and
  2. the lightweight chat GGUF produces a nonempty completion through the same UI/IPC/backend path used by the application.
- Do not bundle a chat model unless the product decision explicitly requires it; tests may use the existing locally supplied tiny model or a configured fixture and skip with a precise reason only when the fixture is absent.

### P1: authentication, authorization, audit, and onboarding

- The first-run experience should explicitly create the initial administrator or explain how one is created. It must not present a generic sign-in form that surfaces raw IPC/FastAPI JSON errors when no user exists.
- Enforce `mustChangePassword` before allowing normal application access and provide a working password-change path.
- Apply one password policy consistently to bootstrap, user creation, and password changes. Validate roles and prevent removal/deactivation of the last active administrator.
- The logout route does not currently declare the authorization value as a FastAPI `Header`, so it may fail to revoke the session. Fix and test revocation.
- `backend/audit/service.py` constructs `AuditLog(metadata=...)`, while the ORM attribute is `audit_metadata`. Observed rows exist but lose their intended metadata and actor attribution. Fix the mapping/call, make important audit-write failures observable without breaking the primary action, and test the stored values for login success/failure, logout, password change, model actions, document actions, admin actions, and restore.
- Revoke the current session on logout, periodically purge/revoke expired sessions, prevent uncontrolled accumulation of active sessions, and provide an administrator/user mechanism to revoke other sessions. The live profile had 12 simultaneously active sessions after testing.
- Use timezone-aware UTC timestamps consistently rather than naive `datetime.utcnow()` values.
- Seed or eliminate the empty roles-table design so the admin roles API and hard-coded permission model agree.

### P1: health, settings, persistence, and recovery

- `backend/admin/routes.py` hard-codes model and embedding runtimes as `healthy`. Health must reflect actual database, worker, model process, embedding process, storage, and backend status, including `degraded` and actionable details.
- Settings are cached and JSON values are modified in place. Ensure persisted changes survive restart and are applied at a controlled point; use fresh immutable/default copies and SQLAlchemy mutation tracking or assignment as appropriate.
- Validate settings and filesystem paths before applying them. Never allow arbitrary renderer input to overwrite executable or protected locations.
- Validate backup and restore with a manifest, schema/app version, integrity check, path traversal protection, atomic replacement, rollback on failure, and an explicit user confirmation in the UI. Test with temporary profiles only.
- Ensure schema migrations are idempotent, transactional, versioned, tested from both a new database and the prior 1.0.0 schema, and do not silently swallow errors.

### P1: crash resistance, supervision, and observability

- Treat the user's report that the application is prone to crashes as a release blocker. First instrument the failure boundaries, then run stress and soak tests to find and fix causes. Do not merely add automatic restart loops that hide defects.
- In Electron main, handle and persist sanitized diagnostics for `uncaughtException`, `unhandledRejection`, `render-process-gone`, `child-process-gone`, renderer `unresponsive`/`responsive`, backend spawn errors/exits, and abnormal application shutdown. Include component, timestamp, app/build version, exit code/reason, bounded recent logs, and correlation ID.
- Add an explicit process supervisor/state machine for the owned backend and llama.cpp children: `stopped`, `starting`, `ready`, `degraded`, `backing_off`, `failed`, and `stopping`. Use bounded exponential backoff, a restart budget/circuit breaker, single-flight starts, readiness probes, and cancellation so repeated failures cannot create restart storms or duplicate processes.
- Distinguish expected shutdown/restart from crashes. Do not restart during app quit, upgrade, restore, uninstall, or an intentional model unload. Ensure every child is placed in a Windows Job Object or equivalent ownership mechanism so children terminate if the Electron parent dies unexpectedly.
- Avoid port-selection races caused by probing a free port and releasing it before spawn. Retry safely on bind collision or adopt a reservation/handshake design.
- Make all database writes for messages, model activation, document/job transitions, settings, and restore atomic. Roll back on failure. Never leave a database model marked `active` when no matching healthy process exists, or a document permanently `queued` without a job/recovery path.
- Bound queues, request bodies, upload sizes, document counts, context length, generation concurrency, memory use, and log growth. Apply backpressure and cancellation rather than freezing or exhausting memory.
- Ensure streaming response generators stop on client disconnect, do not use request-scoped SQLAlchemy sessions after teardown, do not commit partial assistant messages incorrectly, and cannot write to a closed database session.
- Add a diagnostics screen with component health, recent sanitized errors, paths, versions, model load state, retry/reset actions, and one-click export. The UI must remain responsive when the backend or model runtime is unavailable and must never collapse into a blank page.
- Add source maps and symbol/version correlation for local diagnostics, but do not ship secrets or unrestricted debug interfaces.

### P1: reproducible build, packaging, signing, and installation

- There is no root build/test command. Add one documented PowerShell entry point that installs/checks prerequisites, builds renderer and Electron, builds/refreshes the embedded Python backend, verifies llama.cpp and bundled model hashes, runs all tests, packages artifacts, optionally signs, and verifies the result.
- A fresh root `python -m pytest -q tests` currently fails unless import paths and dependencies happen to be set up. Make the documented clean-environment command deterministic. Do not depend on globally installed packages.
- Renderer typecheck/build and Electron TypeScript build currently pass individually. Preserve that.
- The Electron package has no `typecheck` script; either add it or have the root verifier use its actual `build` script consistently.
- Build directories contain copied backend code and caches. Ensure packaging always refreshes application code even when the base Python dependency runtime is cached. Never test stale `backend/build/lib` copies as if they were source.
- Clean only known generated release targets before packaging. Do not recursively delete user or repository roots.
- Use one authoritative version value and propagate it to package metadata, API/UI version, installer filenames, backup compatibility metadata, and release notes. Bump beyond 1.0.0 for this repaired build.
- The current installer was rebuilt after `SHA256SUMS.txt`; its recorded hash is stale. Always generate checksums after all packaging/signing steps, verify each entry, and fail on an unexpected stale artifact. Current audit evidence:
  - actual Setup SHA-256: `ecf60c333cc95d45c88c910b3793aac38a8869f17d1a92cdf6311f3b1f7c1dc7`
  - recorded Setup SHA-256: `17aac727856c137646568900f2d25ba6e7743fcc05dab16191b15c0138bd6489`
  These values are evidence only; they will change after rebuilding.
- The Portable executable is older than the current Setup executable. Do not ship mixed-generation artifacts; assert all release outputs came from the same source/version/build run.
- Complete and test the Authenticode pipeline. Sign all executable code that Windows evaluates, including the application executable, installer/uninstaller, embedded Python executables/extensions where required, and bundled llama.cpp binaries where licensing and tooling permit. Verify signatures with `Get-AuthenticodeSignature` and fail a requested signed release unless every required file is valid and chains correctly.
- Define whether installation is per-user or per-machine. The normal route should not require Administrator unless a documented per-machine option is selected. Test install, first launch, upgrade over the prior build, uninstall, and preservation/removal choices for user data.
- Do not instruct users to disable Smart App Control or antivirus. Document certificate trust requirements for internal/test certificates and use a trusted CA certificate for public distribution.

### P2: maintainability and user experience

- Fix the Vite CJS/module warning and evaluate safe code splitting for the current ~622 kB renderer bundle. Performance cleanup must not delay P0/P1 correctness.
- Add a project `.gitignore`/cleanliness check for generated Python build folders, `__pycache__`, test caches, Node modules, local logs, runtimes, release artifacts, secrets, and certificates, while retaining required lockfiles and source manifests.
- Convert raw `Error invoking remote method ...` messages into concise user-facing errors with a details/copy-log option. Never leak secrets or full internal paths unnecessarily.
- Make every visible menu item either work end to end or be clearly disabled with an explanation. No click should silently do nothing.
- Add local log viewing/export and a diagnostics bundle that redacts credentials and tokens.
- Make ingestion progress explicit: `queued`, `parsing`, `chunking`, `embedding`, `indexing`, `ready`, `failed`, `cancelled`, with timestamps, progress, retry, and a useful failure reason. A successful file copy is not a successful ingestion.
- Make chat state explicit: loading model, ready, generating, cancelling, disconnected, model crashed, and retrying. Disable Send until the selected model is genuinely ready; preserve the user's unsent input and conversation history across recoverable failures.
- Evaluate Electron, electron-builder, Vite, FastAPI, SQLAlchemy, and other dependency updates against current official release/security guidance. Upgrade deliberately with regression tests rather than blindly changing major versions.

## Required test coverage

Add meaningful automated tests, not mocks that merely echo expected results. At minimum:

1. Import every first-party backend module; zero import errors are allowed.
2. Fresh-profile onboarding, login, wrong password, lockout, forced password change, authorization, logout revocation, and restart/session behavior.
3. Transport-secret rejection for missing, wrong, and correct secrets; user-token rejection for missing, expired, revoked, and insufficient permissions.
4. Exact preload-to-main IPC contract coverage for every public method.
5. Conversation create/list/rename/delete, persisted message history, completion, stop generation, and error propagation.
6. Embedding runtime load, 384-dimensional vector generation, unload, crash handling, and restart reconciliation.
7. Document upload and ingestion for representative text, CSV, HTML, DOCX, and PDF fixtures; assert that upload cannot remain `queued` without a durable job; search returns the relevant chunk and source metadata; retry/cancel and corrupt-file behavior work.
8. Retrieval filters, vector parameter ordering, threshold/top-k behavior, and embedding-dimension mismatch migration.
9. Audit rows are created with sanitized metadata.
10. Settings persistence and controlled runtime application.
11. Backup/restore integrity and traversal/invalid archive rejection.
12. Clean build from documented prerequisites, embedded-runtime freshness, resource hashes, package contents, version consistency, checksums, and optional signature verification.
13. Installed-app smoke test under a non-administrator account using an isolated profile: launch, onboarding/login, navigate every menu route, backend health, embedding test, tiny chat completion, close, and verify no orphan backend/llama processes remain.
14. Fault-injection tests: kill backend during an API call, kill llama.cpp during model load and generation, crash/terminate a renderer, force port collision, corrupt a model, remove/write-protect a data directory, exhaust the restart budget, interrupt ingestion, and simulate low disk/memory. Verify responsive UI, accurate state, bounded recovery, preserved data, and useful diagnostics.
15. A repeated start/stop/restart/navigation/upload/chat soak test lasting at least 60 minutes with process count, handles, threads, memory, database locks, and log size monitored for leaks. Also provide a shorter deterministic CI variant.

Tests must not use the real user profile, fixed network ports, or existing credentials. Use temporary directories, ephemeral ports, deterministic fixtures, bounded timeouts, and reliable cleanup.

## Definition of done

Do not declare completion until all of the following are true:

- One documented root verification command exits 0 in a clean developer environment.
- Renderer TypeScript/typecheck/build, Electron TypeScript build, Python compile/import checks, backend tests, contract tests, and end-to-end smoke tests pass.
- There are no production code paths containing an intentional stub (`return []`, unimplemented `pass`, TODO cancellation/retrieval, fake health) for a feature exposed in the UI.
- Every menu item and primary workflow works from the packaged application.
- A document can be ingested and retrieved through the bundled BGE embedding model, and retrieval can contribute cited context to chat.
- A compatible tiny chat GGUF returns a real completion; runtime crashes produce a useful diagnostic.
- The database never contains a document stuck in `queued` with no corresponding actionable job, and never claims an active model whose process is absent or unhealthy.
- Fault-injection and soak tests meet documented recovery and resource thresholds without blank windows, duplicate/orphan processes, restart storms, database corruption, or silent data loss.
- Normal install and launch do not require Administrator and do not require disabling Windows security.
- Release artifacts are from one build, versioned consistently, optionally signed as requested, and have freshly verified SHA-256 checksums.
- Closing or restarting the app leaves no orphan Python or llama.cpp processes.
- Existing user data survives upgrade; destructive reset is explicit and recoverable.

## Final deliverable

After implementation, provide a concise report containing:

1. root causes fixed, grouped by subsystem;
2. files changed and any migration performed;
3. exact commands run with pass/fail results;
4. packaged artifact names, sizes, SHA-256 hashes, and Authenticode status;
5. a manual Windows smoke-test checklist and results;
6. any remaining external blocker, limited to items genuinely impossible without user-owned material such as a production signing certificate.

If a test fails, continue debugging until it passes or identify a concrete external blocker with logs and reproduction steps. Do not call the project finished based only on successful compilation or an installer being generated.
