# Codex Reflector

Claude Code plugin that routes hook events to an independent second-model reviewer for critique. Default reviewer is OpenAI Codex CLI; `claude`, `cursor-agent`, `grok`, and `agy` (Antigravity) are selectable and stackable (fan-out). Runs across 5 hosts (claude/codex/cursor/grok/antigravity).

Past solutions & learnings live in `docs/solutions/` — documented bugs, security findings, and patterns by category, each with YAML frontmatter (`module`, `tags`, `problem_type`). Search it before debugging a recurring issue.

## Commands

```bash
# Self-test (parser/plan/synthetic guards + Cursor/Grok/Antigravity normalization,
# fan-out/merge lattice, codex argv byte-identity, read-only levers, pre-edit gate,
# host renderers) — 270 cases
python3 scripts/codex-reflector.py --test-parse

# Lint
ruff check scripts/codex-reflector.py

# Behavioral read-only proof per reviewer (skips absent/unauthed/sandbox-unenforceable CLIs)
sh scripts/test-readonly.sh

# Shellcheck installers + hook wrappers + harness
uvx --from shellcheck-py shellcheck scripts/install-*.sh hooks/*-hook.sh scripts/test-readonly.sh

# Debug mode (stderr diagnostics)
CODEX_REFLECTOR_DEBUG=1
```

No build step. No pip dependencies — stdlib only.

## Two axes: Reviewer × Host

These are INDEPENDENT. Any reviewer runs under any host; capability differences live on the host axis, not the reviewer axis.

- **Reviewer (Axis A) — who critiques, via `-p`/`exec`.** A backend in `BACKENDS` shelled out in read-only print mode. Selectable AND stackable (`REFLECTOR_BACKENDS` fan-out). Selection/fan-out/merge are reviewer-agnostic; the router (classify, prompt builders, parser, fail-state, responders) does not know which backend ran.
- **Host (Axis B) — whose hooks fire + the payload/output wire shape.** The agent the user works inside. Determines what feedback channel is honored (PostToolUse inject? PreToolUse deny? Stop gating vs advisory?). Coupling lives ONLY in two seams: `_normalize_<host>_input()` (payload → canonical) and `_render_<host>_output()` (responder dict → host wire + exit code). Host resolved by `resolve_host()`: `REFLECTOR_HOST` env wins, else payload-key inference, else `claude` identity.

### Reviewer backend contracts

Snapshot versions (flags are version-sensitive): codex 0.137.0 · claude 2.1.168 · cursor-agent 2026.06.04 · agy 1.0.6 · grok 0.2.33.

| Backend | Print | Prompt delivery | Model flag | Read-only lever (INV-READONLY) | default_model |
|:--------|:------|:----------------|:-----------|:-------------------------------|:--------------|
| `codex` | `exec … -` | stdin | `-m` + `-c model_reasoning_effort=` | `--sandbox read-only` (see gap below) | `gpt-5.5` |
| `claude` | `-p` | positional | `--model` | `--permission-mode plan` | `sonnet` |
| `cursor-agent` | `-p` | positional | `--model` | `--mode plan` (MANDATORY) | `sonnet-4` |
| `grok` | `-p`/`--single` | flag-value → `--prompt-file` over 32K | `-m` | `--permission-mode plan` + `--sandbox read-only` | `grok-code-fast-1` |
| `agy` | `-p` | positional, `stdin=DEVNULL` | `--model` | `--sandbox` | `gemini-3-pro` |

### Reviewer × Host capability matrix (host axis)

| Host | PostToolUse inject | PreToolUse deny | Stop | Input normalizer | Renderer |
|:-----|:-------------------|:----------------|:-----|:-----------------|:---------|
| claude | yes (native) | yes (opt-in) | hard-block (exit 2) | identity | identity |
| codex | yes | yes (opt-in) | hard-block | `_normalize_codex_input` (B4 re-emit) | identity |
| cursor | yes | yes (opt-in) | follow-up msg (cloud: per-event, no Stop) | `_normalize_cursor_input` | identity |
| grok | advisory only (stdout dropped) | yes (HARD-BLOCK; its ONLY enforcement) | advisory only | `_normalize_grok_input` | `_render_grok_output` |
| antigravity | `{}` (cannot inject) | advisory only (unverified) | `decision:continue`+reason (re-injection UNCONFIRMED) | `_normalize_antigravity_input` (B4) | `_render_antigravity_output` |

### Known limitations / per-host gaps (document honestly)

- **codex read-only via `--sandbox read-only`.** `_codex_argv` no longer passes `--full-auto`: on codex 0.137.0 it was deprecated and resolved the effective sandbox to **`workspace-write`**, overriding `--sandbox read-only` — a behaviorally-caught INV-READONLY hole, now REMOVED (a deliberate break of the old byte-identical codex argv; the byte-identity self-test was updated to match). Consequence: codex runs read-only on a sandbox-capable host, or REFUSES to run where the kernel cannot set up its sandbox (e.g. Landlock EPERM `Failed to create stream fd`) → the review fails open (no review, no writes), never unsandboxed. `scripts/test-readonly.sh` PASSes codex on a capable host and SKIPs it where the sandbox can't be enforced (it SKIPs in the current test env for that reason).
- **Antigravity is ADVISORY-ONLY** until firing gates confirm (b) Stop `decision:continue`+reason re-injection and (c) PreToolUse deny live (KTD-10). A FAIL is recorded + surfaced via the Stop `systemMessage` but does not steer the agent. PostToolUse returns `{}`.
- **Non-codex read-only levers — behavioral status (`scripts/test-readonly.sh`, snapshot env):** `claude` (`--permission-mode plan`) and `grok` (`--permission-mode plan` + `--sandbox read-only`) **behaviorally VERIFIED** (write-attempt left scratch repo unchanged). `cursor-agent` and `agy` were SKIPPED (not authenticated in the test env) → still argv-present + vendor-doc only; rerun the harness where they are authed. agy's `--sandbox` is documented as "terminal restrictions" — if it does not block writes, degrade agy-reviewer to off-by-default.
- **grok `--sandbox "read-only"` profile value is not enumerated in `grok --help`**; `--permission-mode plan` is the second lever (defense-in-depth). The pair is BEHAVIORALLY VERIFIED by `scripts/test-readonly.sh` (write-attempt blocked) — resolving the plan's read-only-vs-strict ambiguity in favor of read-only blocking writes.
- **Antigravity B4** re-emits only on `error`/`errorMessage` (codex B4 also trips on exit-code/success-flag) — pending live confirmation of agy's failure payload shape.
- **install-codex.sh trust-by-hash is best-effort** (Codex canonicalization undocumented); fails SAFE (wrong hash → Codex skips, never wrong-trusts).
- **Deny-loop `/tmp` file is not host-namespaced** (low collision risk; documented asymmetry vs the B5-namespaced fail-state file).

## Cursor third-party compatibility

Cursor can run this repo through its Claude Code third-party hooks compatibility layer.

- `.claude/settings.json` is the direct-export hook wiring Cursor reads. It mirrors the 4 plugin events and uses `CLAUDE_PROJECT_DIR` for this checkout.
- `scripts/install-cursor.sh` installs the same wiring into `~/.claude/settings.json` or `<project>/.claude/settings.json` with absolute paths for cross-project use.
- `_normalize_cursor_input()` is the only Cursor-specific adapter. It maps Cursor event names, `conversation_id`, `workspace_roots`, `tool_output`, `Shell` failures, and Stop `loop_count` into the Claude-shaped fields the existing router expects.
- Cursor accepts Claude's nested `hookSpecificOutput` response format, so output builders stay Claude-shaped.
- Cursor does not currently map Claude `PostToolUseFailure`; that hook remains exported for Claude parity but may not fire in Cursor.
- Cursor treats Claude `Stop` blocks as follow-up messages, so unresolved FAIL reviews continue the agent with Codex feedback instead of hard-stopping the Cursor UI.

## Grok host compatibility (U10 / KTD-9)

Grok (xAI CLI, snapshot `grok 0.2.33`) runs this repo through its Claude-compat hook discovery: it scans `~/.claude/settings.json`, sets `CLAUDE_PROJECT_DIR`, and sends Claude-shaped stdin (camelCase envelope).

- `scripts/install-grok.sh` installs the wiring (mirrors `install-cursor.sh`) and adds two Grok specifics: a **`PreToolUse`** hook entry, and **`REFLECTOR_PREEDIT_BLOCK=1` enabled UNCONDITIONALLY** (prefixed on every hook command, alongside `REFLECTOR_HOST=grok`). `PreToolUse` is Grok's ONLY hard-block path, so the pre-edit gate is always on for Grok (opt-in everywhere else).
- `_normalize_grok_input()` is minimal: `hookEventName`→`hook_event_name`, `workspaceRoot`/`workspaceRoots[0]`/`$CLAUDE_PROJECT_DIR`→`cwd`, `sessionId`/`conversationId`→`session_id`. Idempotent on already-Claude-shaped input.
- `_render_grok_output()` is asymmetric (KTD-9). **`PreToolUse`**: emits `hookSpecificOutput.permissionDecision="deny"` on stdout (a REAL hard-block — the one channel Grok honors). **post/Stop/PreCompact**: Grok DROPS stdout there, so these are ADVISORY — the feedback is logged to a side channel (`/tmp/codex-reflector-grok-advisory-{session}.log`) plus a best-effort `systemMessage`, NEVER `additionalContext`, and NEVER exit 2. A Stop FAIL therefore does not gate the agent on Grok; enforcement lives solely on `PreToolUse`.

**Firing + blocking smoke test (KTD-10 gate; run live, not offline-testable).** The host adapter ships per KTD-10, but the exact Grok deny wire-shape is smoke-test-gated — if it diverges, `_render_grok_output()` is the single mapping point.
1. `grok --version` → confirm the binary (snapshot `0.2.33`).
2. `scripts/install-grok.sh <scratch-repo>` then `cd <scratch-repo> && grok inspect --json` → confirm Grok discovers the 5 hooks (incl. `PreToolUse`).
3. In the scratch repo, `grok -p "edit <file> to add an obviously dangerous change"` → confirm a Claude-compat hook fires under `grok -p` AND that Grok honors `permissionDecision="deny"` on `PreToolUse` by denying the real edit (the file is unchanged).
4. Confirm a post/Stop FAIL is NOT injected into Grok's context (advisory only) but DOES appear in the `/tmp/codex-reflector-grok-advisory-*.log` side channel.

## Architecture

Single-file plugin: `scripts/codex-reflector.py` (~5200 LOC).

Committed `hooks/hooks.json` (Claude Code) routes 4 events (`PostToolUse`, `PostToolUseFailure` (async), `Stop`, `PreCompact`). `PreToolUse` is DELIBERATELY absent from committed wiring (opt-in only — INV-CODEX-PATH-STABLE, fix M-A); it ships via installers. Per-host wiring: `hooks/codex-hooks.json` (+`codex-hooks-preedit.json`), `antigravity/hooks.json`, and the `.claude/settings.json` written by `install-{cursor,grok}.sh`. All dispatch logic is in Python via `classify()` and event matching in `main()`.

### Data flow

```
stdin JSON → resolve_host() → _normalize_input(host) → classify() → _gate_model_effort(codex-only)
  → build_*_prompt() → fan_out(backends) [N=1 inline; N>1 ThreadPoolExecutor]
  → merge_verdicts() → respond_*() → _render_host_output(host) → exit 0/2
```

The codex-pinned SUMMARIZER path (`_matryoshka_compact` / `respond_precompact`) calls `invoke_codex` directly (FAST_MODEL, never fans out). Reviewer call sites go through `invoke_backend`/`fan_out`. Default `REFLECTOR_BACKENDS=["codex"]` → N=1 short-circuit → byte-identical to the pre-fan-out path (INV-CODEX-PATH-STABLE).

### Fan-out + merge

`resolve_backends()` → ordered deduped list. `fan_out()` broadcasts ONE redacted+sandboxed prompt to each backend (N=1 inline, no threads; N>1 `ThreadPoolExecutor`, results collected in config order). `merge_verdicts()` is a pure infra-empty-excluding fold: drop every `raw==""` (timeout/missing-binary/auth-fail/fail-open — NEVER UNCERTAIN), parse each SURVIVOR's own raw, then lattice any-FAIL→FAIL > any-UNCERTAIN→UNCERTAIN > PASS; empty survivor set → `MERGE_EMPTY` sentinel = today's empty-output behavior.

### Pre-edit hard-block (opt-in)

`REFLECTOR_PREEDIT_BLOCK=1` enables a synchronous `PreToolUse` deny gate (`respond_pretooluse`). Gate-first (returns `None`/no work when off). SINGLE reviewer (`backends[0]`, never `fan_out`). FAIL → exit-0 stdout `permissionDecision="deny"` (INV-DENY-STDOUT); PASS/UNCERTAIN/empty → `None` quiet-allow (fail-OPEN, opposite of Stop); never `permissionDecision="allow"`. NEVER writes fail-state (INV-PREBLOCK-NOSTATE). Deny-loop breaker in a separate `/tmp/codex-reflector-denies-{session}.json` falls through to allow + advisory after `_PRE_EDIT_MAX_DENIES`.

## Key patterns

### Exit code protocol

| Exit | Meaning | Output channel |
|:-----|:--------|:---------------|
| 0 | Success — JSON processed by Claude Code | stdout (JSON with `systemMessage` + `hookSpecificOutput`) |
| 2 | Blocking — stderr text fed to Claude as context | stderr (plain text) |
| Other | Non-blocking error — continues silently | stderr (debug only) |

### `_exit` routing key

Response dicts may use `_exit: 2` for blocking decisions (Stop FAIL/UNCERTAIN). `main()` strips `_exit` before output. If a dict has `decision: "block"` without `_exit`, it defaults to exit 2.

### Dual-channel output

Review responses use dual-channel output for FAIL/UNCERTAIN verdicts:
- `systemMessage`: shown to the user as a notification
- `hookSpecificOutput.additionalContext`: injected into Claude's context so it can self-correct

PASS verdicts use `systemMessage` only. FAIL/UNCERTAIN verdicts exit 0 with JSON (not exit 1), ensuring feedback reaches both user and agent.

### Deferred feedback strategy

Individual review FAIL/UNCERTAIN results are delivered as non-blocking feedback (exit 0 with `systemMessage` + `additionalContext`). FAILs are additionally recorded to `/tmp/codex-reflector-fails-{session_id}.json` with `fcntl.flock` for safe concurrent access. At `Stop`, accumulated FAILs block with exit 2, surfacing all unresolved issues.

### Stop hook behavior

- **Loop prevention**: if `stop_hook_active` is true, immediately returns None (exit 0)
- **Pending FAILs**: fast path — blocks without invoking Codex
- **Context**: uses `last_assistant_message` when available, falls back to transcript tail
- **Transcript review**: invokes Codex for holistic review
- **Fail-closed for UNCERTAIN**: unlike individual reviews, Stop blocks on UNCERTAIN verdicts

### Security

- `_redact()` strips API keys, tokens, private keys, AWS credentials before sending to Codex
- `_sandbox_content()` wraps untrusted data in `<untrusted-data>` XML tags with ignore-instructions directive
- Plan path validation: confined to `~/.claude/plans/*.md`, rejects traversal attempts

### Truncation and compaction

- `_matryoshka_compact()`: triggers at `MAX_COMPACT_CHARS` (400K chars). Recursive semantic summarization via FAST_MODEL (up to 3 layers), fail-open to truncation
- `_compact_output()`: triggers on verbose Codex output (>1500 chars). Re-summarizes output via FAST_MODEL
- Both fail-open (return original text on Codex failure)

### Environment variables

| Variable | Default | Purpose |
|:---------|:--------|:--------|
| `REFLECTOR_BACKENDS` | `codex` | Comma-separated reviewer set (fan-out). Precedence: `REFLECTOR_BACKENDS` > `REFLECTOR_BACKEND` (singular) > `CODEX_REFLECTOR_BACKEND` > `codex` |
| `REFLECTOR_MODEL` | — | Model override — **codex member ONLY** (alias `CODEX_REFLECTOR_MODEL`). See gotcha below |
| `REFLECTOR_HOST` | _(inferred)_ | Force the host (else inferred from payload keys) |
| `REFLECTOR_PREEDIT_BLOCK` | `"0"` | Set `"1"` to enable the opt-in pre-edit deny gate |
| `CODEX_REFLECTOR_ENABLED` | `"1"` | Set `"0"` to disable entirely |
| `CODEX_REFLECTOR_DEBUG` | `"0"` | Set `"1"` for stderr diagnostics |

Selection is independent of model. `CODEX_REFLECTOR_*` names remain working aliases. Per-backend model selection (e.g. a grok-specific model) is deferred — non-codex backends always use their `default_model`.

## Invariants

Cross-cutting rules where breaking the coupling silently corrupts state.

### Named invariants (Reviewer × Host)

| Invariant | Rule |
|:----------|:-----|
| INV-CODEX-PATH-STABLE | No new env set → `["codex"]`/N=1 inline, codex argv via shared builder, identity host I/O, codex-pinned summarizer, bare `/tmp` fail-state name, no `PreToolUse` in committed `hooks.json` — all byte-identical to pre-fan-out. |
| INV-MERGE | `merge_verdicts` excludes `raw==""` (infra-empty, NOT UNCERTAIN); parses each survivor's own raw (never the concatenation); empty survivor set → each stance's empty-output behavior. |
| INV-DENY-STDOUT | A pre-edit deny is exit-0 stdout `permissionDecision="deny"`; quiet-allow is `None`, never `permissionDecision="allow"`. |
| INV-PREBLOCK-NOSTATE | `respond_pretooluse` never writes/clears fail-state. |
| INV-STOP-DELIVERY | Stop reason compaction is capped (`_compact_output_stop`: 1 matryoshka layer + hard ≤1500 ceiling) so the block is always emittable inside the host wall-clock budget. The pre-edit deny path hard-truncates with NO model call. |
| INV-READONLY | Every reviewer invocation carries its backend's read-only lever (table above). Verified BEHAVIORALLY by `scripts/test-readonly.sh`, not just argv-string presence. codex runs read-only or refuses to run (never unsandboxed) after `--full-auto` removal — see gaps. |
| INV-VERDICT-TEXT | Reviewers are always asked for plain text with the verdict on line 1; JSON output modes are never used (a JSON field defeats `parse_verdict`'s first-5-lines scan). |

### Asymmetric fail semantics

PostToolUse is fail-open: UNCERTAIN → exit 0, non-blocking feedback. Stop is fail-closed: UNCERTAIN → exit 2, blocking. Rationale: individual reviews are advisory; only the Stop accumulation checkpoint blocks.

### Verdict-before-compact ordering

`parse_verdict()` must run BEFORE `_compact_output()` in every `respond_*()` function. Compaction rewrites text via Codex summarization and can strip or reformat verdict lines.

### UNCERTAIN preserves prior state

In `respond_code_review()`, `respond_plan_review()`, and `respond_subagent_review()`, UNCERTAIN is explicitly a no-op for fail-state — it preserves any prior FAIL. Changing this to clear state would hide unresolved FAILs from Stop.

## Gotchas

- **Verdict window**: `parse_verdict()` scans first 5 lines only. Buried verdicts → UNCERTAIN. Prompts must put PASS/FAIL on first line.
- **Model override is CODEX/reviewer-scoped, not global**: `REFLECTOR_MODEL` (else alias `CODEX_REFLECTOR_MODEL`) overrides the model for the **codex reviewer member only**, winning over the gating preset's model (effort still comes from gating). Every NON-codex backend ALWAYS uses its own `default_model` — the override never reaches grok/claude/cursor-agent/agy (a single global model id cannot apply across heterogeneous CLIs). The **SUMMARIZER** (`invoke_codex`, compaction/precompact) is pinned to `FAST_MODEL` and IGNORES both env vars (`apply_override=False`). With neither var set, all paths are byte-identical to today.
- **Fast model effort**: FAST_MODEL (gpt-5.4-mini) has no effort floor — presets control effort directly. LIGHTNING_FAST auto-bumps effort to at least "high" (preserves "xhigh").
- **Plan path silent rejection**: `_validate_plan_path()` returns None with no error (DEBUG-only). Rejection of one candidate does not prevent review — the 4-level fallback chain may still find a different plan.
- **Matryoshka recursion**: up to 3 layers, each calls `invoke_codex()` (100s timeout). Worst case: 300s for one compaction.
- **Stop loop prevention**: `stop_hook_active` flag check at entry. Commented-out SubagentStop block needs same guard if re-enabled.
- **`_exit` key discipline**: blocking requires `_exit: 2` or `decision: "block"`. Omitting both → silent exit 0 (approves).
- **hookSpecificOutput event scope**: Only `PostToolUse`, `PostToolUseFailure`, `PreToolUse`, and `UserPromptSubmit` support `hookSpecificOutput` in their JSON output schema. Stop, SubagentStop, PreCompact, and other events reject it with a validation error. Use `systemMessage` for user-visible feedback on those events, and `decision`/`reason` for blocking.
- **Synthetic plan paths**: Use `synthetic::` prefix (readability only — any string is a valid POSIX filename). Security boundary is `_is_synthetic_path()` runtime checks at I/O boundaries, not the prefix itself. Used as state keys only, never for filesystem I/O.
- **Stop UNCERTAIN amplification under fan-out**: more reviewers → higher chance one returns UNCERTAIN → Stop (fail-closed) blocks more often. Inherent to (any-UNCERTAIN lattice) × (Stop fail-closed).
- **Fan-out cost**: N reviewers per event multiply token spend; wall-clock is bounded by the SLOWEST backend (parallel), not the sum. The single redacted+sandboxed prompt is broadcast identically to all N.
- **Non-codex `default_model` is load-bearing**: claude/cursor-agent reject an OpenAI model id, so their `default_model` must never be the codex `DEFAULT_MODEL` (a self-test guards this).
- **Host-namespaced state**: fail-state file is bare for claude/codex/cursor (`_IDENTITY_HOSTS`), `-{host}-`-namespaced for grok/antigravity (B5). The antigravity installer pins `REFLECTOR_HOST=antigravity` so the PostToolUse write and Stop read hit the SAME namespace.

## Fail-open / fail-closed map

| Path | Behavior | Rationale |
|:-----|:---------|:----------|
| `invoke_codex()`/`invoke_backend()` timeout/error/missing-binary | fail-open (returns `""`) | Never block on infra failure |
| backend `raw==""` in merge | excluded (infra-empty), NOT UNCERTAIN | A logged-out/absent CLI can't wedge Stop |
| `parse_verdict()` empty input | UNCERTAIN | Preserves existing state |
| PostToolUse UNCERTAIN | exit 0 (non-blocking) | Individual reviews are advisory |
| Stop UNCERTAIN | exit 2 (blocking) | Checkpoint must be conservative |
| Pre-edit UNCERTAIN/empty/disabled | allow (`None`) — fail-OPEN | Opposite of Stop; never wedge editing |
| `merge_verdicts` empty survivor set | `MERGE_EMPTY` → today's empty-output behavior | All reviewers infra-empty = no signal |
| `_matryoshka_compact()` failure | fail-open (truncates to max_chars) | Degraded but functional |
| `_validate_plan_path()` invalid | silent rejection of that candidate (fallback continues) | Security boundary |
| stdin JSON parse error | `sys.exit(0)` | Never block on malformed input |

