---
title: The end-of-options double-dash is portable and load-bearing — reject reviewer GNUism nits against the spec
category: conventions
problem_type: best_practice
module: scripts/install-antigravity.sh, scripts/test-readonly.sh
component: cp -- / readlink -- end-of-options guard (POSIX install + test scripts)
tags:
  - posix
  - shell
  - portability
  - end-of-options
  - code-review
  - false-positive
status: active
---

# The end-of-options double-dash is portable and load-bearing — reject reviewer GNUism nits against the spec

## Problem

During PR #2's review cycle the automated reviewer Copilot posted two findings
claiming POSIX-portability bugs, both targeting an end-of-options `--`:

- `scripts/install-antigravity.sh:238` — `cp -- "$settings_path" "$backup"` —
  *"`cp --` is a GNU extension and not POSIX; this script otherwise claims POSIX sh."*
- `scripts/test-readonly.sh:236` — `readlink -- "$_path"` —
  *"`readlink --` is not portable (the `--` is a GNUism)."*

Both claims are false, and the suggested "fix" — strip the `--` — would not make
the scripts more portable. It would re-introduce a real defect. The decision was
not *how to apply* the nit but *whether to*: a confident, well-formatted reviewer
assertion against a defensive construct.

## Symptoms

- A bot review thread asserts `cmd -- ARG` / `readlink -- PATH` is a non-POSIX
  "GNUism" on a script that advertises POSIX `sh`, and proposes removing `--`.
- The flagged token is a defensive end-of-options guard, not a stylistic tic, so
  "fixing" it silently drops a safety property — the diff looks like a no-op
  cleanup but changes argument parsing.
- The reviewer cites no spec text; the claim rests on fluency, not authority.

## What didn't work

- **Trusting the reviewer's confidence.** Copilot's phrasing is authoritative and
  formatted like a real finding. Neither claim survives a look at the primary
  source: `cp --` *is* POSIX, and `readlink` is not a POSIX utility at all, so
  "not POSIX" is not even the right axis for it.
- **Applying the nit (removing `--`).** This was rejected as actively harmful. With
  the guard gone, any operand whose value begins with `-` is re-interpreted as an
  option — a dash-prefixed-path misparse the `--` existed to prevent.

## Solution

Keep the `--`. Dispose of the comment with **reject-with-spec-citation**, then
resolve the thread. The rationale per utility:

```sh
# scripts/install-antigravity.sh:238  — cp is a POSIX standard utility
cp -- "$settings_path" "$backup"

# scripts/test-readonly.sh:236  — readlink is NOT in POSIX; bar is impl acceptance
if _tgt=$(readlink -- "$_path" 2>/dev/null); then
```

- **`cp --` is POSIX-conformant.** POSIX *Utility Syntax Guidelines*, **Guideline
  10**: "The first `--` argument that is not an option-argument should be accepted
  as a delimiter indicating the end of options. Any following arguments should be
  treated as operands, even if they begin with the `-` character." The general
  guideline says "should," but `cp`'s own POSIX page upgrades it to a requirement:
  *"The `cp` utility shall conform to XBD 12.2 Utility Syntax Guidelines."* So
  `cp -- src dst` is conformance, not a GNU extension. BSD/macOS `cp` accepts it too.
- **`readlink --` is accepted by every implementation we target.** `readlink` is
  not specified by POSIX at all, so the bar is *not* "POSIX blesses `--`" — it is
  "GNU coreutils and BSD/macOS `readlink` both accept it." Both are getopt-based
  and honor `--`. So the justification is implementation acceptance, stated as
  such, not a POSIX claim.

Disposition that was applied: posted "Not applying" replies citing Guideline 10
(for `cp`) and getopt behavior (for `readlink`), re-verified each cited line
against current code, then resolved the GitHub review threads via the GraphQL
`resolveReviewThread` mutation.

## Why this works

Stripping `--` does not make the script more portable — it makes it wrong. It
re-opens a genuine misparse / argument-injection hazard: any operand starting
with `-` (a settings path, a symlink target, a tracked filename) gets read as an
option. Concretely, with the guard removed:

```sh
readlink "-n"      # parsed as the -n flag (no trailing newline), NOT a path
cp "-rf" "$backup" # -rf parsed as options (recursive/force), NOT the source operand
```

With `--` present, `-n` / `-rf` are forced to be operands — which is the entire
point of the guard. The "portability fix" trades a non-bug for a real one.

## Prevention

- **Bot fluency is not authority.** Automated reviewers (Copilot, CodeRabbit,
  gemini) emit confident, well-formatted false positives on spec and portability
  questions. Before applying any portability "fix," verify against the primary
  source — the POSIX text, or the actual implementation's option parser.
- **The cost asymmetry is steep.** Accepting the nit is one click, but it can
  silently remove a safety property. A wrong "fix" is worse than no change.
- **`--` is load-bearing whenever an operand can start with `-`.** Keep it on any
  `cmd -- PATH` where the path is user-supplied or filesystem-derived. The right
  axis is "does every targeted implementation accept `--`" (yes for `cp` via
  POSIX, yes for `readlink` via GNU+BSD getopt), not "is the utility in POSIX."
- **Reject reviewably.** A rejection should cite the spec precisely enough
  (Guideline 10; getopt acceptance) that the rejection is itself reviewable, then
  resolve the thread so a human sees no dangling disposition.

## Related

- `docs/solutions/security/readonly-sandbox-levers-need-behavioral-verification.md`
  — sibling epistemic lesson, and shares `scripts/test-readonly.sh`. There:
  argv-string presence is not behavior, verify with a harness. Here: a reviewer's
  confident assertion is not truth, verify against the primary spec. Same
  "distrust the surface signal, consult the authority" pattern on a different
  signal.
- `docs/solutions/conventions/installer-dedup-must-match-all-command-variants.md`
  — nearest `conventions/` neighbor, same `install-*.sh` family; a sibling
  POSIX-shell convention.
