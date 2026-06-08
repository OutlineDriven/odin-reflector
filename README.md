# Outline-Driven Development — Reflector

> Multi-backend meta-reflection layer for Claude Code (and 4 other agent hosts). Add-on plugin.

**Methodology**: [outline-driven-development](https://github.com/OutlineDriven/outline-driven-development) &nbsp;·&nbsp; **Claude Code plugin**: [odin-claude-plugin](https://github.com/OutlineDriven/odin-claude-plugin) &nbsp;·&nbsp; **Site**: [outlinedriven.github.io](https://outlinedriven.github.io)

---

Independent critic, oracle, and metacognition layer for AI coding agents. The agent acts; a *different model* reviews. Every code change gets a second opinion; every thinking step gets metacognitive reflection from another model family.

The reflector has two independent axes:

- **Reviewer** — *which* model critiques. Default `codex`; `claude`, `cursor-agent`, `grok`, and `agy` (Antigravity) are selectable and **stackable** (fan-out: several reviewers per event, verdicts merged).
- **Host** — *which* agent you run inside. Supported: Claude Code (native), Codex, Cursor, Grok, Antigravity. Each fires hooks and honors feedback differently.

Default behavior (no env set) is a single `codex` reviewer on Claude Code — byte-identical to the original plugin.

## Requirements

- Python 3.8+ (stdlib only, no pip dependencies).
- At least one reviewer CLI on PATH (`codex` by default). Each reviewer must be authenticated; a missing or logged-out CLI is skipped (treated as no-output, never a FAIL).

## Install (Claude Code)

```bash
claude plugin marketplace add OutlineDriven/odin-reflector
claude plugin install codex-reflector@odin-reflector
```

Restart Claude Code. Committed `hooks/hooks.json` wires `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`. The pre-edit gate is opt-in (see below) and not wired by default.

## Selecting reviewers / fan-out

Set `REFLECTOR_BACKENDS` to a comma-separated list:

```bash
REFLECTOR_BACKENDS=codex                 # default (single reviewer)
REFLECTOR_BACKENDS=codex,claude          # fan-out: both review every event, verdicts merged
REFLECTOR_BACKENDS=grok                  # single non-codex reviewer
```

Merge rule: any-FAIL → FAIL, else any-UNCERTAIN → UNCERTAIN, else PASS. A reviewer that is absent / unauthenticated / times out is excluded from the merge (it can never turn a clean run into UNCERTAIN). Wall-clock is bounded by the slowest reviewer (they run in parallel); token cost scales with N.

Aliases (all working): `REFLECTOR_BACKENDS` > `REFLECTOR_BACKEND` (singular) > `CODEX_REFLECTOR_BACKEND` > `codex`.

## The pre-edit gate (opt-in hard-block)

By default the reflector reviews edits *after* they land and asks the agent to self-correct. The opt-in pre-edit gate reviews a *proposed* edit *before* it lands and can **deny** high-severity ones (security, data loss, clear correctness bugs):

```bash
REFLECTOR_PREEDIT_BLOCK=1
```

It is conservative by design: single reviewer (no fan-out), and PASS / UNCERTAIN / timeout all **allow** the edit (fail-open) so it never wedges editing. A deny-loop breaker allows an edit after it has been denied twice. It never auto-approves — a non-blocked edit still goes through your normal permission prompt. On Claude Code / Codex / Cursor, install with `--pre-edit` / `--preedit` (below). On Grok it is **always on** (Grok's only enforcement path).

## Install per host

Each installer writes that host's native hook wiring with absolute paths to this checkout.

```bash
# Cursor — Claude-compat hooks. Add --pre-edit to also wire the deny gate.
scripts/install-cursor.sh [--pre-edit] [target-project-dir]

# Codex — native ~/.codex/hooks.json + trust-by-hash. Add --preedit for the deny gate.
scripts/install-codex.sh [--preedit] [target-project-dir]

# Grok — Claude-compat hooks. Pre-edit hard-block is enabled UNCONDITIONALLY (Grok's only block path).
scripts/install-grok.sh [target-project-dir]

# Antigravity — native JSON hooks; also flips the enable_json_hooks setting.
scripts/install-antigravity.sh [--settings-path PATH] [--hooks-path PATH]
```

All installers are idempotent (re-running converges; they dedupe their own entries) and merge into an existing config when `jq` is available (else `--force` to replace).

## Reviewer × Host matrix

Any reviewer runs under any host. What differs is the *host's* feedback capability:

| Host | After-edit review | Pre-edit deny | Stop checkpoint |
|:-----|:------------------|:--------------|:----------------|
| Claude Code | injected into context | yes (opt-in) | hard-block until FAILs resolved |
| Codex | injected | yes (opt-in) | hard-block |
| Cursor | injected | yes (opt-in) | follow-up message; cloud agents have no Stop (degrades to per-event) |
| Grok | **advisory only** (logged to a side channel) | **yes — its only hard-block** | advisory only |
| Antigravity | cannot inject (returns `{}`) | advisory only (unverified) | re-injects via `decision:continue` (unconfirmed) |

## Reviewer contracts (read-only levers)

Every reviewer runs in a read-only / plan mode so it can critique but not modify files:

| Reviewer | Read-only lever | Default model |
|:---------|:----------------|:--------------|
| `codex` | `--sandbox read-only` | `gpt-5.5` |
| `claude` | `--permission-mode plan` | `sonnet` |
| `cursor-agent` | `--mode plan` | `sonnet-4` |
| `grok` | `--permission-mode plan` + `--sandbox read-only` | `grok-code-fast-1` |
| `agy` | `--sandbox` | `gemini-3-pro` |

`REFLECTOR_MODEL` overrides the model for the **codex reviewer only**; non-codex reviewers always use their default model. Verify read-only behavior yourself with:

```bash
sh scripts/test-readonly.sh            # all reviewers; absent/unauthed/sandbox-unenforceable ones SKIP
sh scripts/test-readonly.sh codex grok # a subset
```

Behavioral status (snapshot test env): **claude** and **grok** verified (write-attempt blocked); **codex** FAILs (see gap below); **cursor-agent** and **agy** were skipped (not authenticated there) — rerun where they are logged in.

## Per-host gaps & known limitations (honest)

- **codex read-only is currently DEFEATED by `--full-auto`.** On codex 0.137.0 the deprecated `--full-auto` flag (passed alongside `--sandbox read-only`) resolves the effective sandbox to `workspace-write`, so the codex reviewer can write to the workspace. `scripts/test-readonly.sh` FAILs codex for this reason — INV-READONLY is **not** behaviorally verified for codex pending a flag fix. If running codex read-only matters to you, treat this as open.
- **Antigravity is advisory-only** until its firing gates are confirmed live: Stop re-injection and PreToolUse deny are unconfirmed. A FAIL is recorded and shown at Stop but does not steer the agent.
- **Cursor cloud agents do not fire `Stop`** — the Stop checkpoint degrades to per-event review there.
- **Grok honors hook output only on `PreToolUse`** — after-edit/Stop reviews are advisory (logged to `/tmp/codex-reflector-grok-advisory-{session}.log` + a best-effort notification).
- **Codex trust-by-hash is best-effort** (Codex's hash canonicalization is undocumented). It fails safe: a wrong hash means Codex skips the hook until you run a one-time `/hooks` review.
- **grok `--sandbox read-only`** profile value is not enumerated in `grok --help`; `--permission-mode plan` is the confirmed lever (both are passed for defense-in-depth).

## Auth prerequisites

Each reviewer needs its own CLI installed and logged in:

| Reviewer | CLI | Auth |
|:---------|:----|:-----|
| codex | `codex` | `codex login` / `OPENAI_API_KEY` |
| claude | `claude` | `claude` login / `ANTHROPIC_API_KEY` |
| cursor-agent | `cursor-agent` | Cursor login |
| grok | `grok` | xAI login / API key |
| agy | `agy` | Antigravity / Google login |

A reviewer whose CLI is absent or logged out is skipped with a visible notice — it never blocks the agent.

## Version snapshot

Reviewer CLI flags are **version-sensitive**; re-confirm against `--help` if a CLI updates.

| CLI | Snapshot version |
|:----|:-----------------|
| codex | 0.137.0 |
| claude | 2.1.168 |
| cursor-agent | 2026.06.04 |
| agy | 1.0.6 |
| grok | 0.2.33 |

## Hook events

| Event | Trigger | Purpose |
|---|---|---|
| PreToolUse | proposed Write/Edit (opt-in) | Pre-edit deny gate for high-severity edits |
| PostToolUse | Write, Edit, morph-edit | Code review with PASS/FAIL/UNCERTAIN verdict |
| PostToolUse | sequential-thinking, actor-critic, shannon | Metacognitive reflection (advisory) |
| PostToolUseFailure | Bash / failed edit | Root-cause diagnosis |
| Stop | agent finishing | Blocks if unresolved FAIL reviews exist |
| PreCompact | context compaction | Summarizes critical session context |

## Safety

- **Fail-open**: infra errors result in `exit 0` (approve). The plugin never blocks the agent due to its own failures.
- **Read-only reviewers**: each reviewer runs under its read-only lever (see contracts; note the codex gap above).
- **Redaction + sandboxing**: `_redact()` strips secrets and `_sandbox_content()` wraps untrusted data before any external call.
- **Loop prevention**: Stop checks `stop_hook_active`; the pre-edit gate has a deny-loop breaker.
- **Concurrent access**: state files use `fcntl.flock`.

## Commands

```bash
python3 scripts/codex-reflector.py --test-parse   # self-test (270 cases)
ruff check scripts/codex-reflector.py             # lint
sh scripts/test-readonly.sh                       # behavioral read-only proof
CODEX_REFLECTOR_DEBUG=1                            # stderr diagnostics
```

## License

Apache-2.0
