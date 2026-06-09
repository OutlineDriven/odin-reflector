---
title: In a redact+truncate pipeline, truncation must come last
category: security
problem_type: security_issue
module: scripts/codex-reflector.py
component: _safe_meta / _redact / build_code_review_prompt
tags:
  - redaction
  - secrets
  - prompt-injection
  - ordering
  - tool-response
  - dogfooding
status: active
---

# In a redact+truncate pipeline, truncation must come last

## Problem

Untrusted `tool_response` metadata (an MCP edit/diagnostic tool controls it) is
interpolated into the reviewer prompt as inline metadata lines — `Tool reported
error:`, `Actual file path:`, `Tool response:` — which sit **outside** the
`_sandbox_content` fence. Two things must happen to each field before it lands
in the prompt: it must be **redacted** (strip secrets so they are never shipped
to the reviewer CLI) and it must be **truncated** to a length cap (keep the
prompt bounded). The order of those two operations is not cosmetic — it decides
whether a secret can leak.

The original inline code applied the slice first and redacted the slice:
`_redact(str(resp_error)[:500])` and `_redact(tool_response.strip()[:1500])`.
That is truncate-then-redact, and it leaks.

## Symptoms

This never fired in production — it was caught in review, so the symptom is the
leak *mechanism*, not an observed incident:

- `_redact` works by `re.sub`-ing whole secret patterns (e.g.
  `(?i)(api[_-]?key|secret|token|...)\s*[=:]\s*\S+`, `bearer\s+\S+`,
  `sk-[A-Za-z0-9]{20,}`) to `[REDACTED]`. Each pattern must match a contiguous
  span to redact it.
- Truncating to `[:limit]` **first** can cut a secret across the `limit`
  boundary. The surviving prefix no longer satisfies the pattern (the value got
  clipped below `{20,}`, or the `\s*[=:]\s*\S+` value tail fell off the end), so
  `re.sub` finds nothing to replace.
- Result: the un-redactable secret prefix is interpolated verbatim into the
  prompt and sent to the reviewer CLI. The redaction step ran but matched
  nothing — a silent miss, no error.

## What didn't work

- **Redacting the already-truncated string** (`_redact(str(value)[:limit])`).
  Redaction can only act on what survives the slice; a secret whose tail was
  truncated away is no longer a redactable pattern, so its head ships in the
  clear. The redaction call "succeeds" (returns a string) while doing nothing.

## Solution

Redact the **full** string, then truncate the redacted result. A secret that
straddled the cap is already collapsed to `[REDACTED]` before the slice runs, so
nothing sensitive can survive at the boundary. This is the body of `_safe_meta`,
which now centralizes every untrusted-metadata interpolation:

```python
def _safe_meta(value: object, limit: int = 500) -> str:
    r"""Sanitize an untrusted tool_response field for an inline prompt metadata
    line (which sits OUTSIDE the _sandbox_content fence). Redacts secrets and
    collapses newlines so a forged "\nPASS\n" cannot land as its own line for
    parse_verdict to read as a verdict (a forged PASS would clear/suppress
    fail-state and let a real FAIL slip past the fail-closed Stop)."""
    # Redact BEFORE truncating: a secret straddling `limit` would otherwise lose
    # its tail and dodge _redact's pattern, leaking the prefix.
    return _redact(str(value))[:limit].replace("\n", " ").replace("\r", " ")
```

The callers changed from truncate-first to a `_safe_meta` call (real diff,
commit 9a51a39):

```python
# build_code_review_prompt — before / after
- response_context = f"\nTool reported error: {_redact(str(resp_error)[:500])}"
+ response_context = f"\nTool reported error: {_safe_meta(resp_error)}"
...
- tr = tool_response.strip()[:500]
- response_context = f"\nTool response: {_redact(tr)}"
+ response_context = f"\nTool response: {_safe_meta(tool_response)}"
```

(`_safe_meta` also newline-collapses for a *different* reason — a forged
`\nPASS\n` in `filePath` would otherwise land as its own verdict line; that
fix and the ordering fix ship together.)

## Why this works

`_redact` is pattern-based `re.sub` over a contiguous match. Redaction is only
correct when it sees the **whole** value — any earlier mutation that can split a
secret defeats it silently. Truncation is exactly such a mutation. Ordering it
last means the lossy step only ever discards already-sanitized text: at worst it
clips a `[REDACTED]` marker, never a live secret. The invariant is general — in
any redact+truncate (or redact+reformat) pipeline, every lossy/splitting
transform must run **after** the pattern-matching sanitizer, never before.

## Prevention

- **Sanitize on the full input; apply lossy transforms last.** Treat
  redaction as requiring its complete input. Truncate, reformat, or re-chunk
  only the already-redacted output.
- **A redaction that returns a string is not proof it redacted anything.**
  `re.sub` with no match is a no-op that looks identical to a successful redact.
  Don't trust call-completion as evidence; the ordering is what makes the match
  possible.
- **Centralize the metadata path.** Before, each call site hand-rolled
  `_redact(...[:N])` and one had the slice in the wrong place. `_safe_meta` is
  now the single chokepoint, so the order is fixed in one place for every
  untrusted-metadata interpolation.

## Related

Notably, this refinement was caught by the **reflector's own PostToolUse
review** of the `_safe_meta` edit (dogfooding) — the same truncate-first mistake
that lived in the old inline code recurred in the first helper draft, and the
second-model reviewer flagged the ordering before it was committed. The commit
message records it: *"the redact-before-truncate refinement was caught by the
reflector's own review."* The broader fix in 9a51a39 was sanitizing untrusted
`tool_response` metadata interpolated outside the `_sandbox_content` fence (the
forged-verdict newline-injection class); see `_sandbox_content`'s
delimiter-breakout defense for the in-fence counterpart.
