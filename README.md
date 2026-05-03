# Outline-Driven Development — Reflector

> Codex CLI meta-reflection layer for Outline-Driven Development. Add-on for the Claude Code plugin.

**Methodology**: [outline-driven-development](https://github.com/OutlineDriven/outline-driven-development) &nbsp;·&nbsp; **Claude Code plugin**: [odin-claude-plugin](https://github.com/OutlineDriven/odin-claude-plugin) &nbsp;·&nbsp; **Site**: [outlinedriven.github.io](https://outlinedriven.github.io)

---

Independent critic, oracle, and metacognition layer for Claude Code using OpenAI Codex CLI.

Claude Code acts. Codex reviews. Every code change gets a second opinion. Every thinking step gets metacognitive reflection from a different model family.

## Requirements

- [Codex CLI](https://github.com/openai/codex) on PATH (`codex exec` must work)
- Python 3.8+ (stdlib only, no pip dependencies)

## Install

```bash
claude plugin marketplace add OutlineDriven/odin-reflector; claude plugin install codex-reflector@odin-reflector
```

### Install as a Cursor Plugin

This repository now includes native Cursor plugin metadata at `.cursor-plugin/plugin.json`.

To install it as a local Cursor plugin, copy or symlink this repository into:

```bash
~/.cursor/plugins/local/codex-reflector
```

Then reload Cursor. The plugin components are auto-discovered from this repository:

- `hooks/hooks.json`
- `rules/codex-reflector-usage.mdc`
- `skills/codex-reflector/SKILL.md`
- `agents/codex-reflector-reviewer.md`
- `commands/install-cursor-plugin.md`

## Use with Cursor

Cursor can run this plugin through its Claude Code third-party hooks compatibility layer.

1. Enable **Third-party skills** in Cursor Settings.
2. Install the direct-export Claude settings:

```bash
scripts/install-cursor.sh
```

That writes `~/.claude/settings.json` with absolute paths to this checkout. To install into a specific project instead, pass the project path:

```bash
scripts/install-cursor.sh /path/to/project
```

When this repository itself is opened in Cursor, the checked-in `.claude/settings.json` also works directly because Cursor provides `CLAUDE_PROJECT_DIR`.

Cursor compatibility notes:

- `PostToolUse`, `Stop`, and `PreCompact` run through Cursor's Claude hook compatibility.
- `PostToolUseFailure` is included in the export for Claude parity, but Cursor does not currently list it in its Claude hook mapping table.
- Cursor treats Claude `Stop` blocks as follow-up messages, so unresolved FAIL reviews cause the agent to continue with Codex feedback instead of hard-stopping the UI.
- The direct export mirrors the Claude plugin matcher. Cursor only fires the parts whose tool names are exposed through its Claude hook compatibility layer.

## Hook Events

| Event | Trigger | Mode | Purpose |
|---|---|---|---|
| PostToolUse | Write, Edit, morph-edit | async | Code review with PASS/FAIL/UNCERTAIN verdict |
| PostToolUse | sequential-thinking, actor-critic, shannon | sync | Metacognitive reflection (advisory, no verdict) |
| PostToolUseFailure | Bash | async | Root cause diagnosis for failed commands |
| Stop | Agent finishing | sync | Blocks if unresolved FAIL reviews exist |
| PreCompact | Context compaction | sync | Summarizes critical session context |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_REFLECTOR_ENABLED` | `1` | Set to `0` to disable all hooks |
| `CODEX_REFLECTOR_MODEL` | _(codex default)_ | Override model for `codex exec` |
| `CODEX_REFLECTOR_DEBUG` | `0` | Set to `1` for stderr diagnostics |

## Activation

Place this plugin at `~/.claude/codex-reflector/` and restart Claude Code.

```
~/.claude/codex-reflector/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── scripts/codex-reflector.py
├── LICENSE
├── README.md
└── .gitignore
```

## How It Works

### Code Reviews (async)

After Write/Edit tool calls, Codex reviews the change in a read-only sandbox. The verdict (PASS/FAIL/UNCERTAIN) and full opinion are delivered as a `systemMessage` on the next conversation turn. Codex's opinions are always returned regardless of verdict.

FAIL verdicts are tracked in a state file. The Stop hook prevents Claude from finishing until all FAILs are resolved.

### Thinking Reflection (sync)

After each thinking MCP tool step (sequential-thinking, actor-critic, shannon), Codex provides immediate metacognitive observations: coherence checks, blind spots, overlooked alternatives, logical gaps. Advisory only — no PASS/FAIL blocking.

### Bash Failure Diagnostics (async)

When Bash commands fail, Codex diagnoses root cause and suggests remediation steps.

### PreCompact Summary (sync)

Before context compaction, Codex reads the session transcript tail and produces a summary of key decisions, unresolved issues, current task state, and important file paths.

## Verdict Parser

The parser extracts PASS/FAIL from Codex's output:

- Strips markdown noise (`**`, backticks, emoji)
- Checks first 5 non-empty lines for verdict words
- Supports keyed formats (`Verdict: PASS`, `result=FAIL`)
- Contradictory signals (both PASS and FAIL) resolve to UNCERTAIN
- **Fail-open**: UNCERTAIN never blocks

Self-test: `python3 scripts/codex-reflector.py --test-parse`

## Safety

- **Fail-open**: All errors result in `exit 0` (approve). The plugin never blocks Claude due to its own failures.
- **Read-only sandbox**: Codex runs with `--sandbox read-only` — it cannot modify files.
- **Infinite loop prevention**: Stop hook checks `stop_hook_active` flag.
- **Concurrent access**: State file uses `fcntl.flock` for safe concurrent writes.

## License

Apache-2.0
