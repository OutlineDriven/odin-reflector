# Codex Reflector

Claude Code plugin that routes hook events to OpenAI Codex CLI for independent second-model review.

## Commands

```bash
# Self-test (verdict parser + plan path extraction + synthetic path guards, 28 cases)
python3 scripts/codex-reflector.py --test-parse

# Lint
ruff check scripts/codex-reflector.py

# Debug mode (stderr diagnostics)
CODEX_REFLECTOR_DEBUG=1
```

No build step. No pip dependencies — stdlib only.

## Architecture

Single-file plugin: `scripts/codex-reflector.py` (~1165 LOC).

`hooks/hooks.json` routes 4 events (`PostToolUse`, `PostToolUseFailure` (async), `Stop`, `PreCompact`) to the same Python script. All dispatch logic is in Python via `classify()` and event matching in `main()`.

### Data flow

```
stdin JSON → classify() → _gate_model_effort() → build_*_prompt() → invoke_codex() → parse_verdict() → respond_*() → exit 0/2
```

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
| `CODEX_REFLECTOR_ENABLED` | `"1"` | Set `"0"` to disable entirely |
| `CODEX_REFLECTOR_MODEL` | — | Override model for all Codex calls |
| `CODEX_REFLECTOR_DEBUG` | `"0"` | Set `"1"` for stderr diagnostics |

## Invariants

Cross-cutting rules where breaking the coupling silently corrupts state.

### Asymmetric fail semantics

PostToolUse is fail-open: UNCERTAIN → exit 0, non-blocking feedback. Stop is fail-closed: UNCERTAIN → exit 2, blocking. Rationale: individual reviews are advisory; only the Stop accumulation checkpoint blocks.

### Verdict-before-compact ordering

`parse_verdict()` must run BEFORE `_compact_output()` in every `respond_*()` function. Compaction rewrites text via Codex summarization and can strip or reformat verdict lines.

### UNCERTAIN preserves prior state

In `respond_code_review()`, `respond_plan_review()`, and `respond_subagent_review()`, UNCERTAIN is explicitly a no-op for fail-state — it preserves any prior FAIL. Changing this to clear state would hide unresolved FAILs from Stop.

## Gotchas

- **Verdict window**: `parse_verdict()` scans first 5 lines only. Buried verdicts → UNCERTAIN. Prompts must put PASS/FAIL on first line.
- **Model override precedence**: `CODEX_REFLECTOR_MODEL` env var overrides ALL model selections including adaptive gating.
- **Fast model effort**: FAST_MODEL (gpt-5.4-mini) has no effort floor — presets control effort directly. LIGHTNING_FAST auto-bumps effort to at least "high" (preserves "xhigh").
- **Plan path silent rejection**: `_validate_plan_path()` returns None with no error (DEBUG-only). Rejection of one candidate does not prevent review — the 4-level fallback chain may still find a different plan.
- **Matryoshka recursion**: up to 3 layers, each calls `invoke_codex()` (100s timeout). Worst case: 300s for one compaction.
- **Stop loop prevention**: `stop_hook_active` flag check at entry. Commented-out SubagentStop block needs same guard if re-enabled.
- **`_exit` key discipline**: blocking requires `_exit: 2` or `decision: "block"`. Omitting both → silent exit 0 (approves).
- **hookSpecificOutput event scope**: Only `PostToolUse`, `PostToolUseFailure`, `PreToolUse`, and `UserPromptSubmit` support `hookSpecificOutput` in their JSON output schema. Stop, SubagentStop, PreCompact, and other events reject it with a validation error. Use `systemMessage` for user-visible feedback on those events, and `decision`/`reason` for blocking.
- **Synthetic plan paths**: Use `synthetic::` prefix (readability only — any string is a valid POSIX filename). Security boundary is `_is_synthetic_path()` runtime checks at I/O boundaries, not the prefix itself. Used as state keys only, never for filesystem I/O.

## Fail-open / fail-closed map

| Path | Behavior | Rationale |
|:-----|:---------|:----------|
| `invoke_codex()` timeout/error | fail-open (returns `""`) | Never block on infra failure |
| `parse_verdict()` empty input | UNCERTAIN | Preserves existing state |
| PostToolUse UNCERTAIN | exit 0 (non-blocking) | Individual reviews are advisory |
| Stop UNCERTAIN | exit 2 (blocking) | Checkpoint must be conservative |
| `_matryoshka_compact()` failure | fail-open (truncates to max_chars) | Degraded but functional |
| `_validate_plan_path()` invalid | silent rejection of that candidate (fallback continues) | Security boundary |
| stdin JSON parse error | `sys.exit(0)` | Never block on malformed input |

