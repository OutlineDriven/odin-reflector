---
name: codex-reflector
description: Configure and validate codex-reflector hook behavior for Claude Code and Cursor.
---

# Codex Reflector Skill

Use this skill when updating hook routing, model-effort heuristics, verdict parsing, or compatibility wiring for Cursor third-party hooks.

## Checklist

1. Keep `hooks/hooks.json` and `.claude/settings.json` behaviorally aligned for supported events.
2. Preserve parser invariants: verdict-before-compaction and UNCERTAIN state preservation.
3. Run:
   - `python3 scripts/codex-reflector.py --test-parse`
   - `ruff check scripts/codex-reflector.py`
   - `bash -n scripts/install-cursor.sh`
