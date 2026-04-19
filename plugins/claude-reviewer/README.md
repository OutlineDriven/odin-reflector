# claude-reviewer

Claude Code reviewer hook — runs `claude -p` as a post-tool reviewer with a haiku→sonnet cost ladder.

A sibling plugin to `codex-reflector` in the `odin-reflector` marketplace. Uses the Claude CLI in non-interactive mode (`claude -p`) instead of OpenAI Codex CLI, with a tiered cost policy that keeps routine reviews cheap and escalates only when complexity signals warrant it.

## Install

```bash
# From the odin-reflector marketplace root
claude plugin install ./plugins/claude-reviewer
```

Or reference the marketplace entry in your Claude Code settings:

```json
{
  "plugins": [
    { "source": "https://github.com/OutlineDriven/codex-reflector", "plugin": "claude-reviewer" }
  ]
}
```

**Prerequisite:** `claude` CLI must be on `$PATH` and authenticated.

## Env knobs

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_REVIEWER_ENABLED` | `"1"` | Set to `"0"` to disable all hooks |
| `CLAUDE_REVIEWER_BASE_MODEL` | `"claude-haiku-4-5"` | Base model for PostToolUse, PostToolUseFailure, PreCompact |
| `CLAUDE_REVIEWER_ESCALATION` | `"haiku,sonnet,opus"` | Comma-separated tier ladder. Maps: `haiku`→`claude-haiku-4-5`, `sonnet`→`claude-sonnet-4-6`, `opus`→`claude-opus-4-7`. Unknown values pass through as literal model IDs. |
| `CLAUDE_REVIEWER_DEBUG` | `"0"` | Set to `"1"` for stderr diagnostics |

## Routing policy

| Event | Default model | Escalation trigger | Fail semantics |
|---|---|---|---|
| `PostToolUse` (Write\|Edit\|Patch…) | `claude-haiku-4-5` | Security-sensitive file, content >5K chars, or >3 files → escalate one tier | fail-open |
| `PostToolUseFailure` (Bash) | `claude-haiku-4-5` | None (diagnostic only) | fail-open |
| `Stop` | `claude-sonnet-4-6` | Pending FAILs present → escalate to opus | fail-closed on UNCERTAIN/FAIL; invocation error → fail-open |
| `PreCompact` | `claude-haiku-4-5` | Transcript >200K chars → sonnet | fail-open |

## Hooks covered

- **PostToolUse** — triggers on: `Write`, `Edit`, `MultiEdit`, `Patch`, `NotebookEdit`, `ExitPlanMode`, `mcp__*morph*`, `mcp__*sequentialthinking*`, `mcp__*sequential_thinking*`, `mcp__*actor-critic*`, `mcp__*shannon*`
- **PostToolUseFailure** — triggers on all tools (routes only `Bash` failures; skips others)
- **Stop** — session-end review; blocks with exit 2 on FAIL or UNCERTAIN
- **PreCompact** — pre-compaction metacognition summary

## Dual-channel output

- `PostToolUse`: writes `{"systemMessage": ..., "hookSpecificOutput": {"additionalContext": ...}}` to stdout for FAIL/UNCERTAIN; systemMessage only for PASS
- `Stop`: exit 2 on FAIL/UNCERTAIN (stderr text fed to Claude); exit 0 on PASS
- `PreCompact`: returns compact summary in `hookSpecificOutput.additionalContext`

## Self-test

```bash
python3 plugins/claude-reviewer/scripts/claude-reviewer.py --test-parse
```

Runs ≥20 `parse_verdict` test cases and exits 0 on success.

## Coexistence with codex-reflector

Both plugins use separate state files (`/tmp/claude-reviewer-fails-*.json` vs `/tmp/codex-reflector-fails-*.json`) and can run concurrently without collision. They are independent reviewers using different backends.
