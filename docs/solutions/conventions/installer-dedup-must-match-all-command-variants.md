---
title: An idempotent installer must dedup on the exact command-set it emits — not a path substring, not just the bare command
category: conventions
problem_type: best_practice
module: scripts/install-cursor.sh
component: jq dedup (without_reflector) / scripts/test-install-idempotent.sh
tags:
  - idempotency
  - installer
  - hooks
  - jq
  - dedup
status: active
---

# An idempotent installer must dedup on the exact command-set it emits — not a path substring, not just the bare command

## Problem

`install-cursor.sh` MERGES the reflector's hooks into a possibly-pre-existing
`~/.claude/settings.json` (or a project one) rather than overwriting it. To stay
idempotent, the merge must first STRIP any prior copy of the installer's own
hooks, then re-add them — otherwise a reinstall accumulates duplicates.

The subtlety: the installer does not emit a single fixed command. The default
run wires the bare command `python3 "<reflector>"`; `--pre-edit` ALSO wires a
`PreToolUse` hook whose command is the prefixed variant
`REFLECTOR_PREEDIT_BLOCK=1 python3 "<reflector>"`. The strip step has to account
for the full SET of commands the installer can emit — no more (or it eats the
user's hooks), no less (or it leaves a variant behind to duplicate).

## Symptoms

- Two `install-cursor.sh --pre-edit <repo>` runs produced TWO `PreToolUse` hook
  entries instead of one. Each duplicate fires `_record_deny` on the same key
  per edit, so the `_PRE_EDIT_MAX_DENIES` loop-breaker trips after one denial
  instead of two — silently weakening the pre-edit gate (afb4478 message).
- Conversely, after the first "fix", a user's own hook that merely referenced
  the reflector path (e.g. `mylogger python3 ".../codex-reflector.py" --tail`)
  was DELETED on every reinstall.

## What didn't work

The correct matcher is bracketed by two OPPOSITE failure modes; both shipped and
both were wrong:

- **Too narrow — bare exact match (original, pre-afb4478).** The dedup was
  `def without_codex($command): … map(select((.command // "") != $command))`,
  matching only the bare `$codex_command`. The `REFLECTOR_PREEDIT_BLOCK=1 …`
  pre-edit variant is a DIFFERENT string, so it survived the strip and was
  re-appended — duplicating on `--pre-edit` reinstall. This was the original bug
  and afb4478's motivation.
- **Too broad — path substring match (afb4478).** The "fix" swapped to
  `select(((.command // "") | contains($script)) | not)`, stripping any command
  *containing* the reflector path. That covered both emitted variants, but it
  ALSO stripped a user-authored hook that merely mentioned the path — clobbering
  it on every reinstall. Caught by `ce-code-review` round 2 (adversarial P2,
  reproduced).

Under-strip duplicates your own hook; over-strip deletes someone else's. The
target is to match exactly the set you emit and nothing else.

## Solution

Define the EXACT commands the installer emits as shell vars (kept byte-matching
the python heredoc that generates them), then strip exactly those two — by `==`,
not substring (5372732):

```sh
# scripts/install-cursor.sh — the two EXACT commands this installer emits
codex_command="python3 \"${reflector_script}\""
pre_edit_command="REFLECTOR_PREEDIT_BLOCK=1 ${codex_command}"
```

```sh
jq --arg cmd "$codex_command" --arg precmd "$pre_edit_command" -s '
  def without_reflector($cmd; $precmd):
    map(
      if has("hooks") then
        . + {hooks: (.hooks | map(select((.command // "") as $c | $c != $cmd and $c != $precmd)))}
      else . end
    )
    | map(select((has("hooks") | not) or ((.hooks // []) | length > 0)));
  …
' "$settings_path" "$tmp_new" > "$tmp_merged"
```

The load-bearing line is `select((.command // "") as $c | $c != $cmd and $c != $precmd)`:
keep a hook unless its command is byte-equal to one of the two we emit.

## Why this works

The strip-set is now precisely the emit-set: exactly the two strings this
installer writes, matched by equality. A user hook is never equal to either (it
has extra args like `--tail`, or a different program), so it survives; both of
our variants are equal to one of them, so neither duplicates.

The general rule that earns this "convention" status: **dedup on the exact
command-set you emit — bare-match under-strips when you emit more than one
variant; substring over-strips into the user's namespace.** `install-grok.sh` is
the control: it emits ONE variant (`REFLECTOR_PREEDIT_BLOCK=1 REFLECTOR_HOST=grok
python3 "<reflector>"`, since the pre-edit gate is unconditional there) and
dedups on that one command, so bare-match is correct *for grok*. Same rule,
different N — cursor emits two, so it needs two.

## Prevention

- **The strip-set must stay in sync with the emit-set.** Adding a future command
  variant (another env prefix, another flag) means updating BOTH the heredoc
  that emits it AND the jq matcher that strips it. They are coupled; a new
  variant silently reintroduces the duplicate bug if only the emitter changes.
- **Regression-guarded by `scripts/test-install-idempotent.sh` (5 checks).**
  `--pre-edit` exercises BOTH variants and asserts run1 hook-count == run2
  hook-count with no duplicate commands; a separate check seeds a user hook
  referencing the path and asserts it SURVIVES reinstall — catching the
  over-strip direction. Run it on any change to the installer's emitted commands
  or the dedup logic.

## Related

- `afb4478` (the over-broad substring "fix"), `5372732` (the two-exact-match
  correction + over-strip regression test). `18d7fef` is interstitial — it
  removed the `codex_command` var orphaned by afb4478's substring switch;
  5372732 reintroduced it because the exact-match approach needs it again.
- `docs/solutions/security/readonly-sandbox-levers-need-behavioral-verification.md`
  — sibling lesson from the same project: argv/string presence is not behavior;
  a real harness (there: write-attempt; here: reinstall + user-hook survival) is
  the arbiter.
