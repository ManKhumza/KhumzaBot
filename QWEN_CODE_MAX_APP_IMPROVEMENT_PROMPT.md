# Qwen Code Max implementation brief — NOC AI Assistant / Khumza Bot

You are the senior engineer responsible for improving this Windows desktop RAG
application end to end. Work directly in the currently open repository and carry
the task through implementation, regression testing, packaging, and a concise
handoff. Do not stop after an audit or provide a speculative plan as the result.

## Mandatory context and operating rules

1. Read `AGENTS.md` and `NEMOTRON_FINAL_REMEDIATION_PROMPT.md` completely before
   changing anything. Treat their safety requirements and definition of done as
   binding.
2. Inspect `git status` and the current diffs first. The worktree intentionally
   contains valuable uncommitted changes from previous remediation work. Preserve
   them. Do not reset, revert, overwrite, or reimplement working changes.
3. Never inspect, modify, migrate, or test with the real
   `%APPDATA%\NOC AI Assistant` profile. Use temporary isolated profiles,
   databases, credentials, ports, documents, and model fixtures.
4. The shipped product must remain private and local/offline by default. Qwen Code
   is being used only as the development agent; do not add the Qwen cloud API or
   any other remote model, telemetry, analytics, or cloud dependency to the app.
5. Never expose credentials, user documents, prompts, tokens, model contents, or
   certificate material in source, logs, tests, terminal output, or commits.
6. Reproduce each problem before fixing it. Implement the smallest coherent
   solution, add meaningful regression coverage, and do not turn failures into
   fake success with stubs, swallowed exceptions, weakened checks, or hard-coded
   responses.
7. Change authoritative source only. Do not patch generated `backend/build`,
   `dist`, packaged output, or copied runtime files.

## Product objective

Make the application feel understandable, trustworthy, and polished for an
administrator setting up a local knowledge-grounded assistant and for an operator
using it daily. Prioritize reliability and clarity over decorative redesign.

Before coding, exercise the application and identify the highest-impact usability
and functional failures across onboarding, model setup, knowledge ingestion,
behavior configuration, chat, citations, errors, and destructive actions. Record
brief reproduction evidence, then implement the most valuable coherent set of
improvements below. Do not expand into unrelated architecture rewrites.

## Required feature: administrator-controlled chatbot behavior prompt

The worktree already contains an initial global `behavior` policy. Audit it before
changing it, retain what works, and complete it as a first-class admin feature.

Create a clear **Chatbot Behavior** section in Settings that only administrators
can edit. It must include:

- A large multiline **Behavior prompt / system instructions** editor where an
  administrator can describe the chatbot's role, tone, constraints, answer style,
  and operating rules in plain language.
- Clear helper text explaining that this prompt applies globally to every chat and
  cannot be overridden by ordinary operators.
- Save state that is obvious: unsaved-changes indication, validation, saving,
  success confirmation, and useful error feedback.
- A safe **Reset to recommended default** action with confirmation. Do not silently
  erase an administrator's prompt.
- The existing source policy controls, presented in understandable language:
  knowledge only, knowledge preferred, or model only; selected source or all
  accessible sources; citation style; maximum sources; relevance threshold; and
  the exact no-knowledge response.
- Sensible, safe defaults. Knowledge-only mode must never invent an answer when no
  supporting passage is available.
- Server-side authorization and validation. Hiding controls in React is not access
  control. Operators must receive HTTP 403 if they attempt to change global
  behavior through the API.
- Application of the saved behavior on every completion without requiring an app
  restart. Conversation-level text must not quietly override the administrator's
  global restrictions.
- Prompt-injection resistance: retrieved document text is untrusted reference
  material and must never be treated as system instructions.
- Tests proving persistence across restart, administrator/operator permissions,
  live policy application, grounding behavior, reset behavior, validation, and
  redaction from logs/diagnostics.

Do not merely add a textarea whose value is stored but unused. Trace the value from
the UI through Electron IPC and FastAPI persistence into the exact messages sent
to llama.cpp, and test that complete path.

## Required RAG and chat experience

Preserve and strengthen the retrieval fixes already present in this worktree:
cosine relevance scoring for normalized vectors, BGE query framing, keyword plus
semantic retrieval, candidate overfetch, source selection guards, citations, and
knowledge-source deletion.

Verify with an isolated realistic corpus containing long medicinal-herb entries
and distractors. The query below must retrieve answer-bearing passages from the
selected Khumza source and produce a cited, grounded answer:

> Give me a medicinal herb for headache from the Khumza knowledge base.

This is a retrieval/grounding acceptance test, not permission to hard-code an herb
or answer. Do not test against the user's actual knowledge bank. The test fixture
must include multiple relevant and irrelevant passages and must fail if the app
only searches the first few generic vector matches.

Improve these user journeys:

- A new knowledge-only chat must not silently run with no selected searchable
  source. Auto-select and persist the sole ready source when unambiguous; otherwise
  block sending and open a clear source chooser.
- Show source readiness using real ready-document/searchable-chunk state. Explain
  queued, indexing, failed, empty, and ready states and provide the next action.
- Make model and knowledge-source selectors large, scrollable, keyboard accessible,
  and usable with long names. Make the current selection unmistakable.
- Distinguish “no source selected,” “source has no indexed content,” “no relevant
  passage,” “model unavailable,” “retrieval failed,” and “generation failed.” Do
  not collapse these into a silent empty result or one misleading refusal.
- Keep the user's draft when sending is blocked or an error occurs.
- Render citations clearly with document, collection, page/section when known,
  relevance, preview, and accessible expand/collapse behavior.
- Do not discard a non-empty grounded answer merely because a small model missed
  exact citation punctuation. Citation metadata is owned and attached by the
  backend; never accept an out-of-range or fabricated source number.
- Ensure every visible retrieval setting actually affects the active chat/search
  path. Remove or clearly mark controls that are genuinely unsupported rather than
  leaving decorative settings.

## Overall UX improvements

Create a cohesive setup-to-chat experience without replacing the established
visual system:

- A readiness overview showing, in order: local backend, chat model, embedding
  model, ready knowledge source, and behavior policy. Each incomplete item should
  link to the screen where it can be fixed.
- Honest wording: knowledge is not “optional” when the global mode is knowledge
  only.
- Model import and activation feedback that surfaces runtime errors instead of
  writing only to the developer console. Prevent invalid role/model combinations.
- Knowledge ingestion progress, status, failure details, retry, document deletion,
  and source deletion with accessible confirmations and recovery-oriented wording.
- Consistent loading, empty, success, warning, and error states throughout the
  application. Avoid modal/panel layouts that are too small to read or select.
- Responsive layouts at common laptop widths, visible keyboard focus, logical tab
  order, useful labels, adequate contrast, and no hover-only essential controls.
- Preserve data and avoid surprising destructive actions. Do not delete models,
  documents, sources, conversations, or settings without explicit confirmation.

Prefer a few well-finished workflows over broad cosmetic churn. Reuse existing
components and tokens. Do not introduce a second design system or large dependency
without a concrete need.

## Local model and packaging constraint

`resources/models/Qwen3-4B-Q4_K_M.gguf` may exist locally as a development/user
download and is intentionally ignored by Git. Do not accidentally turn every
release installer into a multi-gigabyte artifact merely because `*.gguf` is under
`resources/models`. Make packaging behavior explicit:

- Continue bundling and checksum-verifying the small BGE embedding model required
  for offline retrieval.
- Treat large chat models as separately imported local assets unless the product
  intentionally implements, documents, and tests a bundled-chat-model release.
- Never download a model during normal application startup.
- Preserve user-imported models across upgrades.

Qwen3 chat models should run without hidden reasoning for routine interactive use
on CPU-only hardware unless the user explicitly requests reasoning. Keep the
default 4096-token context appropriate for the target i7-8700/16 GB system and do
not claim GPU acceleration that is unavailable.

## Verification and definition of done

Add or improve tests for every changed behavior. At minimum cover:

- behavior policy persistence, reset, permissions, validation, and actual prompt
  application;
- long-document hybrid retrieval for the headache/herb acceptance query;
- source selection and zero-chunk blocking;
- distinct backend/UI error states;
- citation attachment and invalid citation handling;
- model import/activation errors;
- destructive deletion consistency across database, vectors, files, and references;
- version and package integrity, including exclusion of the large ignored chat
  model unless intentionally bundled.

Then follow the repository's required loop exactly:

1. Run focused tests while iterating.
2. Run `./scripts/quality-gate.ps1` from the repository root.
3. Read `.artifacts/nemotron/quality-report.json` and fix every failed gate.
4. Repeat until it exits 0.
5. For the deliverable, bump the patch version consistently and run
   `./scripts/quality-gate.ps1 -Package`.
6. Inspect the final JSON report; do not infer success from console snippets.
7. Report the installer path, byte size, SHA-256, signature status, test count, and
   any genuinely unresolved external prerequisite. The release may be described as
   complete only if the packaged gate passes.

Do not commit, push, publish, install over the user's live application, or touch the
real user profile unless the user separately and explicitly requests that action.
