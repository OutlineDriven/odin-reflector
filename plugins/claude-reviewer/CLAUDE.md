# claude-reviewer — invariants

## Fail semantics (asymmetric by design)

| Event | Semantics | Rationale |
|---|---|---|
| `PostToolUse` | **fail-open** — empty/error response → PASS assumed | Never block agent progress on transient reviewer failures |
| `PostToolUseFailure` | **fail-open** — empty/error response → no-op | Diagnostic only; agent already knows the tool failed |
| `Stop` | **fail-closed on UNCERTAIN** — UNCERTAIN/FAIL blocks; empty/error response → allow (fail-open on invocation failure) | Final gate for model verdicts; transient claude CLI failures do not permanently block the agent |
| `PreCompact` | **fail-open** — empty/error response → skip | Compaction proceeds unimpeded |

## UNCERTAIN preserves prior state

`parse_verdict` returns `UNCERTAIN` when the model output is ambiguous, empty, or contradictory (PASS + FAIL in same window). The UNCERTAIN contract:
- `PostToolUse` code-change: no state change (prior FAIL for same file stays recorded)
- `Stop`: UNCERTAIN treated as FAIL (fail-closed) — blocks with `_exit: 2`; empty/error claude response → allow (invocation failures are fail-open)
- Any event: never clears an existing FAIL entry

## `_exit: 2` blocking discipline

`_exit(result)` routes based on `result["_exit"]` or `result["decision"] == "block"`:
- Exit 0 → JSON to stdout → harness processes `systemMessage` + `hookSpecificOutput`
- Exit 2 → `reason`/`systemMessage` printed to stderr → harness feeds text to Claude as context and **blocks** the action

Only `Stop` with FAIL or UNCERTAIN uses exit 2. All `PostToolUse` paths use exit 0 (non-blocking).

## 5-line verdict window

`parse_verdict` only inspects the first 5 lines of model output. Prompts must ensure the verdict word appears on line 1. This is intentional: it forces model discipline and prevents verdict burial in verbose output.

## haiku → sonnet → opus escalation policy

Default ladder: `claude-haiku-4-5` → `claude-sonnet-4-6` → `claude-opus-4-7`

Escalation triggers (hardcoded, not configurable per-event):
- `PostToolUse` code-change: security-sensitive file, large content (>5K chars), or multi-file (>3 files) → escalate base model one tier
- `Stop`: always starts at sonnet; pending FAILs present → escalate to opus
- `PreCompact`: transcript > 200K chars → escalate haiku → sonnet

The ladder is controlled by `CLAUDE_REVIEWER_ESCALATION` (comma-separated tier names). Unknown tiers pass through verbatim as model IDs.

## Prompt injection hardening

All attacker-controlled data (file content, command output, stderr, plan text, transcript) is:
1. Redacted via `_redact()` to strip secrets
2. Wrapped in `_sandbox_content()` XML delimiters before insertion into prompts

The `build_bash_failure_prompt` function sandboxes the entire data block (command + error + stdout/stderr + heuristic hints) in a single `<untrusted-data>` block. No attacker-controlled text appears outside the sandbox.

## State file isolation

FAIL state is persisted in `/tmp/claude-reviewer-fails-<session_id>.json` (separate from `codex-reflector-fails-*.json`). Both plugins can run concurrently without state collisions.
