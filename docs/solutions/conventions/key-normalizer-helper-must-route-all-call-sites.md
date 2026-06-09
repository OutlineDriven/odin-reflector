---
title: A key-normalizer helper must route ALL call sites at once, or write/read silently disagree
category: conventions
problem_type: best_practice
module: scripts/codex-reflector.py
component: _resolve_session_id / main / respond_stop / respond_pretooluse
tags:
  - session-id
  - fail-state
  - cross-process
  - normalization
  - refactoring
  - INV-CODEX-PATH-STABLE
status: active
---

# A key-normalizer helper must route ALL call sites at once, or write/read silently disagree

## Problem

`session_id` is the key under which a PostToolUse FAIL is stored and later read
back at Stop. The two hooks are **separate process invocations** — there is no
shared memory, so each process must recompute the key identically from the
payload it was handed. When a host omits `session_id`, the write path and the
read path each independently turn `hook_data.get("session_id", "")` into `""`.

`_atomic_update_state` and `_read_state` both bail on an empty id —
`if not session_id: return []` (lines 1700-1701, 1726-1727). So a PostToolUse
FAIL written under `""` is dropped on the floor, and Stop reading under `""`
finds nothing. The agent finishes with an unresolved FAIL and Stop never blocks.

When introducing a helper to normalize a key shared across a write path and a
read path — especially across processes — **every former inline
`get(key, "")` site must be routed through the helper simultaneously**. A
partial wiring leaves a silent write/read key mismatch that no single-side test
catches.

## Symptoms

- Hosts that omit `session_id` (e.g. Grok, whose installer enables the pre-edit
  gate unconditionally) lost PostToolUse FAILs entirely; Stop never gated on them.
- The self-test pins the latent bug directly: after `write_fail_state("", ...)`,
  `_read_state("")` returns `[]` — `check("empty session_id FAIL is dropped (the
  latent bug)", _read_state(""), [])`.
- No crash, no log line. The drop is silent because the empty-id guards are a
  legitimate no-op for the normal "no session" case — they just also swallow the
  FAIL.

## What didn't work

- **Wiring only one side.** The first cut routed only `respond_stop` (the read)
  through the new helper. That still fails: the write in `main()` keeps emitting
  `""`, so the FAIL is dropped before Stop ever reads. The reverse is just as
  broken — write under `nosession-<hash>`, read under `""` → `_read_state` bails
  → no block. The fix only holds when **both** the write and the read derive the
  key the same way. The read-both-paths requirement was caught by the project's
  own ce-code-review pass.
- **Leaving a parallel inline copy.** `respond_pretooluse` already had the
  correct `or nosession-<hash>` fallback inline (it was the original mirror the
  helper was modeled on), so it was *behavior-identical* — not a third dropped
  FAIL. But a second byte-for-byte copy of the key formula is free to drift from
  the helper later. The ce-simplify-code pass flagged it on reuse/quality/
  efficiency grounds; it was routed through the helper too so all three sites
  share one owner.

## Solution

Introduce one canonical normalizer and route every key-derivation site through
it in the same change. The helper returns a host-sent id unchanged
(INV-CODEX-PATH-STABLE) and falls back to a `cwd`-derived id otherwise:

```python
def _resolve_session_id(hook_data: dict, cwd: str) -> str:
    """Canonical session key for the PostToolUse-write / Stop-read fail-state
    paths and the pre-edit deny-loop breaker. Falls back to a stable per-cwd
    'nosession-<hash>' when the host omits session_id, so a PostToolUse FAIL is
    recorded AND read by Stop under the SAME key. ..."""
    return hook_data.get("session_id") or (
        "nosession-"
        + hashlib.sha256(cwd.encode("utf-8", errors="replace")).hexdigest()[:16]
    )
```

All three sites then read identically — `session_id = _resolve_session_id(hook_data, cwd)`
— in `main()` (PostToolUse write, line 5213), `respond_stop` (Stop read, line
2051), and `respond_pretooluse` (deny-loop breaker key, line 2230). `fc9ab2b`
added the helper and wired the write+read pair; `c667abc` folded in the third
site.

## Why this works

PostToolUse and Stop run in **different processes** with no shared state, so the
only thing that makes write and read agree is recomputing the key by the same
deterministic rule in each process. `cwd` is the one stable cross-process key
available when `session_id` is absent — both invocations see the same working
directory — so `nosession-<sha256(cwd)[:16]>` lets a session-less write and a
session-less read land in the same state file. Centralizing that rule in one
helper makes "the same rule everywhere" a property of the code, not a
coincidence maintained by hand at each call site.

Note the helper spans two *different* stores: the fail-state file (write/read)
and the pre-edit deny-loop breaker's own `/tmp` file (`respond_pretooluse` never
touches fail-state — INV-PREBLOCK-NOSTATE). The shared concern is the
*key derivation*, not the store.

## Prevention

- **Route all sites in one commit.** When a key is shared across write and read
  (cross-process especially), grep every `get("<key>", "")` and convert them
  together. A green test on one side is not evidence the other side agrees —
  only an end-to-end write-then-read test is. The self-test now writes a FAIL
  under a session-less payload's `cwd` and asserts `respond_stop` blocks on it
  via the pending-FAIL fast path.
- **Don't leave a parallel inline copy of the formula.** Even when
  behavior-identical today, a duplicated key formula is a future drift hazard;
  one owner removes that class entirely.
- **Accepted tradeoff (residual, by design):** two concurrent session-less runs
  in the same `cwd` share one state key and therefore one fail-state file. That
  is inherent to deriving the key from `cwd` — the only cross-process-stable
  value when `session_id` is missing — and is the unavoidable cost of write/read
  agreement, not a TODO. Re-introducing per-call uniqueness would re-break the
  agreement this convention exists to guarantee.

## Related

- `docs/solutions/security/readonly-sandbox-levers-need-behavioral-verification.md`
  — same lesson on a different axis: argv-presence (one site looking right) is
  not proof of the effective behavior across the whole path.
- Commits `fc9ab2b` (helper + write/read wiring) and `c667abc` (third site,
  Graft/compress).
