---
title: A fan-out worker exception inverts the fail-closed Stop checkpoint to fail-open
category: security
problem_type: security_issue
module: scripts/codex-reflector.py
component: fan_out / _future_raw / invoke_backend
tags:
  - fan-out
  - fail-closed
  - fail-open
  - threadpoolexecutor
  - exception-handling
  - INV-MERGE
status: active
---

# A fan-out worker exception inverts the fail-closed Stop checkpoint to fail-open

## Problem

The Stop hook is the reflector's fail-CLOSED checkpoint: unresolved FAILs (and
even UNCERTAIN) must block with exit 2 so the agent cannot finish over an
unaddressed review. In a fail-closed path, an unhandled exception is not a
neutral crash — it is itself a safety inversion. If the hook dies, exit 1 is
*non-blocking* on Stop, so a crash silently lets the agent through.

Under fan-out (`REFLECTOR_BACKENDS` with N>1), `fan_out` ran each reviewer in a
`ThreadPoolExecutor` and collected results with `f.result()`. `invoke_backend`
is documented fail-open (returns `""` on timeout/missing-binary/OSError), but
`f.result()` *re-raises* any exception a worker raised that `invoke_backend` did
not already convert to `""`. One such escape: `invoke_backend`'s `mkstemp` ran
OUTSIDE its `try`, so a tmpfile `OSError` (disk full) — or a `PermissionError`
on a platform where it escapes the `OSError` catch — propagated out of the
worker. The list comprehension `[(name, f.result()) for ...]` then aborted on
the first raising future, **discarding the other backends' verdicts**, and the
exception propagated through `respond_stop`/`main` with no top-level catch,
crashing the hook. A fail-closed checkpoint became fail-open.

## Symptoms

- N>1 fan-out where one backend's worker raised: the hook exited non-zero
  (exit 1) instead of emitting a verdict. On Stop, exit 1 is non-blocking, so
  the agent finished even with a real FAIL pending from a *surviving* backend.
- The other backends' verdicts were lost entirely — the comprehension never
  reached them once one `f.result()` re-raised.

## What didn't work

- **Relying on `invoke_backend`'s fail-open contract alone.** It catches
  `TimeoutExpired`/`FileNotFoundError`/`OSError`, but its `mkstemp` was outside
  the `try`, and a non-`OSError` exception (or a platform-specific
  `PermissionError` escape) bypassed the catch entirely. The contract held only
  for the failures it explicitly enumerated.
- **`f.result()` in the collection comprehension.** It re-raises; one worker's
  exception aborts the whole `zip` and propagates. There was no top-level catch
  in `respond_stop`/`main` to convert it to a safe state.

## Solution

Two changes (commit `cf19cad`). First, wrap each future's result in
`_future_raw`, converting *any* `Exception` to `""` — infra-empty, which
`merge_verdicts` excludes (INV-MERGE), exactly as if that backend had timed out:

```python
def _future_raw(future: "concurrent.futures.Future") -> str:
    """fan_out worker result, fail-open. A worker exception invoke_backend did
    NOT already convert to '' (e.g. an mkstemp error on a platform whose
    PermissionError escapes the OSError catch) becomes infra-empty here, so one
    backend can never discard the others' verdicts nor crash the hook (which on
    a fail-closed Stop would silently invert it to fail-open)."""
    try:
        return future.result()
    except Exception as exc:  # noqa: BLE001 - last-resort fail-open backstop
        debug(f"fan_out worker error: {exc}")
        return ""
```

The N>1 collection now reads
`[(name, _future_raw(f)) for name, f in zip(backends, futures, strict=True)]`
instead of `[(name, f.result()) for ...]`.

Second, move `invoke_backend`'s `mkstemp` INSIDE its `try` so a tmpfile error
fails open at the source like every other I/O failure there:

```python
    out_fd = out_path = None
    prompt_path = None
    try:
        if backend.output_capture == "file":
            # Inside the try so a tmpfile OSError (e.g. disk full) fails open
            # ('') like every other I/O failure here, not crashes the caller.
            out_fd, out_path = tempfile.mkstemp(suffix=".txt", prefix="codex-ref-")
            os.close(out_fd)
```

## Why this works

A raising worker now yields `""` instead of an exception. `merge_verdicts`
drops every `raw==""` survivor (INV-MERGE) before folding, so the failed
backend is treated as infra-empty (no signal), not UNCERTAIN, and the
*surviving* backends' verdicts still reach the lattice (any-FAIL→FAIL >
any-UNCERTAIN→UNCERTAIN > PASS). The hook never crashes, so the Stop exit-2
block still fires when a survivor returns FAIL. The fix is layered:
`invoke_backend` fails open at the I/O source, and `_future_raw` is the
last-resort backstop for anything that still escapes — defense in depth around
the fail-closed boundary.

A regression test asserts the property directly: a raising N>1 worker yields
`("grok", "")` while the other survives (`("codex", "PASS from codex")`), and
`merge_verdicts` of that pair returns `PASS` — not a crash, not UNCERTAIN
(272/272 self-test cases).

## Prevention

- **In a fail-closed path, treat an unhandled exception as a safety inversion,
  not a neutral error.** The exit code of a crash matters: exit 1 is
  non-blocking on Stop, so a crash *is* a fail-open. Every path that can crash
  inside a fail-closed checkpoint needs an explicit safe-state conversion.
- **`Future.result()` re-raises.** When collecting from a `ThreadPoolExecutor`,
  a single raising worker aborts the whole collection and discards its
  siblings. Wrap each result so one worker can never take down the batch.
- **Keep resource acquisition (mkstemp) inside the fail-open `try`.** Setup that
  runs before the guard is an unguarded crash surface even when the body is
  carefully fail-open.

## Related

Found by ce-code-review (adversarial P1, corroborated by prior learnings). The
hole was latent in the fan-out feature: the default `REFLECTOR_BACKENDS=["codex"]`
takes the N=1 inline short-circuit (INV-CODEX-PATH-STABLE), which never touches
the executor, so only multi-reviewer configs were exposed. Same lesson as
`readonly-sandbox-levers-need-behavioral-verification.md`: a fail-open
*contract* (invoke_backend returns `""`) is only as strong as the code path that
actually enforces it — here, an exception route and an out-of-`try` mkstemp both
bypassed it until an adversarial review and a regression test pinned the
property down.
