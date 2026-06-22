# Outline-Driven Development — Reflector

> Codex CLI meta-reflection layer for Outline-Driven Development. Add-on for the Claude Code plugin, with a native oh-my-pi port.

**Methodology**: [outline-driven-development](https://github.com/OutlineDriven/outline-driven-development) &nbsp;·&nbsp; **Claude Code plugin**: [odin-claude-plugin](https://github.com/OutlineDriven/odin-claude-plugin) &nbsp;·&nbsp; **Site**: [outlinedriven.github.io](https://outlinedriven.github.io)

---

Independent critic, oracle, and metacognition layer using OpenAI Codex CLI.

The agent acts. Codex reviews. Every code change gets a second opinion. Every thinking step gets metacognitive reflection from a different model family.

## Requirements

- [Codex CLI](https://github.com/openai/codex) on PATH (`codex exec` must work) — required by **both** surfaces.

The reflector ships in two surfaces; install whichever matches your agent:

- **[Claude Code plugin](#claude-code-plugin)** — the original single-file Python hook. Needs Python 3.8+ (stdlib only, no pip dependencies).
- **[oh-my-pi (omp)](#oh-my-pi-omp)** — a native TypeScript port, no Python runtime. Needs the `omp` CLI.

---

## Claude Code plugin

A single-file Python hook (`scripts/codex-reflector.py`, stdlib only) wired through `hooks/hooks.json`. Requires Python 3.8+.

### Install

```bash
claude plugin marketplace add OutlineDriven/odin-reflector; claude plugin install codex-reflector@odin-reflector
```

### Activation

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

### Hook events

| Event | Trigger | Mode | Purpose |
|---|---|---|---|
| PostToolUse | Write, Edit, morph-edit | async | Code review with PASS/FAIL/UNCERTAIN verdict |
| PostToolUse | sequential-thinking, actor-critic, shannon | sync | Metacognitive reflection (advisory, no verdict) |
| PostToolUseFailure | Bash | async | Root cause diagnosis for failed commands |
| Stop | Agent finishing | sync | Fresh holistic review; blocks on FAIL only (PASS/UNCERTAIN settle) |
| PreCompact | Context compaction | sync | Summarizes critical session context |

### Use with Cursor

Cursor can run this plugin through its Claude Code third-party hooks compatibility layer.

#### Install as a Cursor plugin

This repository includes native Cursor plugin metadata at `.cursor-plugin/plugin.json`.

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

#### Direct-export hooks

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
- Cursor treats Claude `Stop` blocks as follow-up messages, so a FAIL Stop review causes the agent to continue with Codex feedback instead of hard-stopping the UI.
- The direct export mirrors the Claude plugin matcher. Cursor only fires the parts whose tool names are exposed through its Claude hook compatibility layer.

---

## oh-my-pi (omp)

A native TypeScript port of this reflector ships at `omp/codex-reflector.ts` — no Python runtime; it calls `codex exec` directly. It registers oh-my-pi extension handlers that mirror the Claude plugin: code review on `write`/`edit`/`ast_edit` and Fast-Apply MCP edits, root-cause diagnostics on failed `bash` and Fast-Apply calls, metacognitive reflection on thinking-MCP steps (`sequential`, `shannon`), and a pre-compaction session summary.

### Installation Guide

#### 1. Install the omp CLI

Skip if you already have it ([more options](https://omp.sh)):

```sh
curl -fsSL https://omp.sh/install | sh       # macOS / Linux
bun install -g @oh-my-pi/pi-coding-agent      # any platform, bun >= 1.3.14
```

#### 2. Install the reflector as an extension (recommended)

The module is an oh-my-pi **extension** — a default-export factory that registers handlers via `pi.on`. Its Stop gate uses the extension-only `session_stop` event, so extension loading is the canonical path. Choose one:

- **Manifest from this checkout** — the checked-in `package.json` declares the extension in `omp.extensions` (`./omp/codex-reflector.ts`). Point omp at the repo directory and it resolves the manifest:

  ```sh
  omp -e /path/to/odin-reflector
  ```

- **Auto-discovery** — symlink the module into an extension directory, project-local (`<repo>/.omp/extensions/`) or user-global (`~/.omp/agent/extensions/`):

  ```sh
  mkdir -p ~/.omp/agent/extensions
  ln -s "$(pwd)/omp/codex-reflector.ts" ~/.omp/agent/extensions/codex-reflector.ts
  ```

- **Config** — add the absolute path to the `extensions` array in `~/.omp/agent/config.yml`:

  ```yaml
  extensions:
    - /path/to/odin-reflector/omp/codex-reflector.ts
  ```

For a named omp profile, use that profile's user base (`~/.omp/profiles/<profile>/agent/...`) instead of `~/.omp/agent/...`.

#### Optional: hook-directory install

oh-my-pi can also discover JS/TS hook factories from legacy hook directories. Current omp loads those files through the same extension module pipeline, so `codex-reflector.ts` still registers its extension handlers; this path is equivalent but redundant for this reflector. If you use hook directories, use `hooks/pre/` or `hooks/post/` under the project `.omp/` directory or the user `~/.omp/agent/` directory — never a flat `~/.omp/hooks/`.

```sh
mkdir -p ~/.omp/agent/hooks/post
ln -s "$(pwd)/omp/codex-reflector.ts" ~/.omp/agent/hooks/post/codex-reflector.ts

# project-local equivalent:
mkdir -p .omp/hooks/post
ln -s "$(pwd)/omp/codex-reflector.ts" .omp/hooks/post/codex-reflector.ts
```

### Behavior

Reads the same [environment variables](#environment-variables) as the Claude plugin. Run the unit tests with `bun test omp/codex-reflector.test.ts`.

**Behavioral delta from the Claude plugin:** both ports are stateless. Code reviews inject their verdict and full opinion inline for every verdict; the Stop gate is a fresh holistic review on the native `session_stop` event (main-session-only, awaited before the turn settles). Only a definitive FAIL blocks — it returns `{ decision: "block", reason }` so the agent keeps working with that context; PASS and UNCERTAIN settle (fail-open — never block on uncertainty). It re-runs on each blocked settle attempt, bounded by oh-my-pi's built-in 8-continuation cap.

### Hook events

| omp event | Trigger | Mode | Purpose |
|---|---|---|---|
| `tool_result` | `write` / `edit` / `ast_edit`, Fast-Apply MCP edit | async | Code review with PASS/FAIL/UNCERTAIN verdict |
| `tool_result` | `sequential` / `shannon` thinking-MCP steps | sync | Metacognitive reflection (advisory, no verdict) |
| `tool_result` (`isError`) | failed `bash`, failed Fast-Apply edit | async | Root-cause diagnosis for failed calls |
| `session_stop` | main agent about to settle | sync | Fresh holistic Stop review every stop; only FAIL blocks (PASS/UNCERTAIN settle); native 8-continuation cap |
| `session_before_compact` | context compaction | sync | Summarizes critical session context |

---

## Environment Variables

Both surfaces honor the same variables.

| Variable | Default | Description |
|---|---|---|
| `CODEX_REFLECTOR_ENABLED` | `1` | Set to `0` to disable all hooks |
| `CODEX_REFLECTOR_MODEL` | _(codex default)_ | Override model for `codex exec` |
| `CODEX_REFLECTOR_DEBUG` | `0` | Set to `1` for stderr diagnostics |

## How It Works

Both surfaces run the same Codex reflection loop and keep no FAIL state — reviews inject their verdict and opinion inline, and the Stop hook runs a fresh holistic review rather than consulting persisted state. The implementation specifics below (`--test-parse`, exit-code blocking) describe the Python plugin; the omp port mirrors the behavior with the [delta noted above](#behavior).

### Code Reviews (async)

After Write/Edit tool calls, Codex reviews the change in a read-only sandbox. The verdict (PASS/FAIL/UNCERTAIN) and full opinion are injected inline so the agent sees them on the next turn — returned for every verdict, not just failures. FAIL/UNCERTAIN additionally feed the verdict back as agent context for self-correction.

The reflector keeps no FAIL state. Instead the Stop hook runs a fresh holistic review of the session, and only a definitive FAIL blocks (PASS and UNCERTAIN settle — never block on uncertainty): in the Python plugin it runs once per stop chain — a FAIL blocks via exit `2`, then the `stop_hook_active` guard lets a re-stop settle; in omp it runs on every stop (a FAIL returns `{ decision: "block", reason }`), bounded by the native 8-continuation cap.

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
- **Fail-open**: PASS and UNCERTAIN never block — only a definitive FAIL blocks, and only at the Stop gate. An UNCERTAIN verdict is always treated as non-blocking.

Self-test the parser with `python3 scripts/codex-reflector.py --test-parse` (plugin) or `bun test omp/codex-reflector.test.ts` (omp port).

## Safety

- **Fail-open**: any internal error approves silently and never blocks the agent — the Python plugin exits `0`; the omp hook returns without a block.
- **Read-only sandbox**: Codex runs with `--sandbox read-only` — it cannot modify files (both surfaces).
- **Loop prevention**: the plugin's Stop hook checks the `stop_hook_active` flag; the omp port relies on the native `session_stop` event and oh-my-pi's built-in 8-continuation cap.

## License

Apache-2.0
