---
title: Read-only sandbox levers need behavioral verification, not argv-presence checks
category: security
problem_type: security_issue
module: scripts/codex-reflector.py
component: invoke_backend / _codex_argv / scripts/test-readonly.sh
tags:
  - sandbox
  - read-only
  - codex
  - prompt-injection
  - behavioral-testing
  - INV-READONLY
status: active
---

# Read-only sandbox levers need behavioral verification, not argv-presence checks

## Problem

The reflector shells reviewer CLIs out in print mode to get a second-model
opinion on edits. The entire security model assumes each reviewer runs
**read-only**: it reads the proposed change + repo and emits a verdict, but
cannot mutate the workspace. If a reviewer can write, a prompt-injection planted
in the untrusted content it reviews could make it write arbitrary files.

The codex reviewer argv was `codex exec --sandbox read-only --full-auto ...`.
The self-test asserted the read-only lever was **present** in the argv
(`"--sandbox" in argv`, `"read-only" in argv`) and that no write-enabling flag
appeared. Those tests passed. The reviewer was still writable.

## Symptoms

- `scripts/test-readonly.sh` (a behavioral harness that drives the real CLI with
  a write-attempt prompt against a fresh `git init` scratch repo) showed the
  codex reviewer **created `PWNED.txt`** and appended to a tracked file.
- `codex exec --sandbox read-only --full-auto -` prints the banner
  `sandbox: workspace-write` and `warning: --full-auto is deprecated; use
  --sandbox workspace-write instead.`

## What didn't work

- **Argv-presence assertions.** `--sandbox read-only` was in the argv and the
  test was green, but a *second, later* flag silently overrode it. Presence of
  the right flag is not proof the right behavior results.
- **Trusting the deprecation suggestion.** Codex suggests "use `--sandbox
  workspace-write` instead" — that is still writable; taking it would not fix the
  hole.

## Solution

On codex >= 0.137.0, `--full-auto` is deprecated and resolves the *effective*
sandbox to `workspace-write`, which **overrides** an earlier `--sandbox
read-only`. Remove `--full-auto`; `--sandbox read-only` alone is the real lever.

```python
# _codex_argv() — single source for the codex reviewer AND the codex-pinned summarizer
return [
    "codex", "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    # --full-auto REMOVED: it resolved the sandbox to workspace-write, overriding
    # --sandbox read-only (INV-READONLY).
    "--ephemeral",
    "-c", f"model_reasoning_effort={effort}",
    "-m", model,
]
```

Consequence by host: codex now runs read-only on a sandbox-capable host, or
**refuses to run** where the kernel cannot set up its sandbox (e.g. Landlock
`Failed to create stream fd`) — the review then fails open (no review, no
writes). It never runs unsandboxed.

## Why this works

Two flags both set the sandbox profile; the more permissive/deprecated one won.
Dropping it leaves a single, unambiguous `--sandbox read-only`. "Refuses to run"
is an acceptable safe state: fail-open (no review) beats a writable reviewer.

## Prevention

- **Verify read-only behaviorally, per backend.** Argv-presence is necessary but
  not sufficient. The durable check is a write-attempt against a scratch repo
  asserting the tree is unchanged (`scripts/test-readonly.sh`). It SKIPs
  absent/unauthed CLIs and sandbox-unenforceable kernels rather than
  false-passing.
- **Distrust flag combinations that both set the same knob.** When two flags
  configure one sandbox/permission dimension, one silently wins; assert the
  *effective* result, not the presence of the one you intended.
- **The same class applies to other backends** (documented as gaps until run
  live): grok `--sandbox <profile>` value is not enumerated in `--help`
  (`--permission-mode plan` is the confirmed lever); agy `--sandbox` is
  "terminal restrictions", not provably no-file-writes. Behavioral verification
  is the arbiter for all of them.

## Related

This was found while extending the reflector to multiple reviewer backends
(claude/grok/cursor-agent/agy) + per-host packaging. The bug was pre-existing
(the original single-codex reflector shipped `--full-auto`) and was preserved
byte-identically under the feature's INV-CODEX-PATH-STABLE invariant — until the
behavioral harness (built in the same feature) exposed it. Lesson: a
byte-identity-preservation invariant will faithfully preserve a latent security
bug; behavioral tests are what surface it.
