#!/bin/sh
# Installer idempotency harness.
#
# Every per-host installer MERGES its hooks into an existing config (so users
# keep their own hooks). The merge MUST converge: running an installer twice
# must not duplicate hook entries. The class of bug this guards is a dedup key
# that misses a command variant — e.g. install-cursor.sh once stripped only the
# bare command and so re-appended the "REFLECTOR_PREEDIT_BLOCK=1 ..." PreToolUse
# hook on every `--pre-edit` reinstall (silently halving the pre-edit deny-loop
# threshold). This is deliberately NOT part of `--test-parse`: that suite is
# hermetic/in-process; this one shells out to the installers + jq.
#
# POSIX sh. Skips an installer whose merge dependency (jq) is unavailable, the
# same way scripts/test-readonly.sh skips absent backends — a skip is not a pass.
#
# NOTE: `set -e` is deliberately OFF (only `set -u`). A broken installer must be
# recorded as that installer's FAIL (report() sees a missing/unparseable file ->
# -1 -> FAIL) and the harness must continue to the remaining installers, not
# abort on the first non-zero exit and skip the rest of the matrix.
set -u

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH='' cd -- "$here/.." && pwd -P)

pass=0
fail=0
skip=0

# Clean up every scratch dir on exit (collected in the parent shell, not a
# subshell, so the trap actually sees them).
tmpdirs=""
cleanup() {
  for _t in $tmpdirs; do rm -rf "$_t"; done
}
trap cleanup EXIT INT HUP TERM

mkdir_scratch() {
  _d=$(mktemp -d)
  tmpdirs="$tmpdirs $_d"
  printf '%s' "$_d"
}

# Print "<total-hooks> <duplicate-command-count>" for a {"hooks": {...}} file.
# duplicate-command-count > 0 means some event lists the same command twice —
# a non-idempotent merge, even if the total happens to match a prior run.
# Prints "-1 -1" on a missing/unparseable file so the caller fails loudly.
inspect_hooks() {
  python3 - "$1" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print(-1, -1); sys.exit(0)
hooks = data.get("hooks") or {}
total = dupes = 0
for groups in hooks.values():
    cmds = [h.get("command") for g in groups for h in g.get("hooks", [])]
    total += len(cmds)
    dupes += len(cmds) - len(set(cmds))
print(total, dupes)
PY
}

# report <name> <output-json> -- the installer already ran twice; this inspects
# the final state and compares against the after-run-1 total in $r1_total. Parses
# with `read` so a malformed single-field result leaves dupes empty (-> 0) and a
# missing total (-> -1) rather than aliasing one field into two.
report() {
  _name=$1
  _t2=""; _d2=""
  read -r _t2 _d2 <<EOF
$(inspect_hooks "$2")
EOF
  : "${_t2:=-1}"
  : "${_d2:=0}"
  if [ "$r1_total" -gt 0 ] && [ "$r1_total" -eq "$_t2" ] && [ "$_d2" -eq 0 ]; then
    printf 'PASS %s (%s hooks, no duplicates, stable across reinstall)\n' "$_name" "$_t2"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (run1=%s hooks; run2=%s hooks, %s duplicate command(s))\n' \
      "$_name" "$r1_total" "$_t2" "$_d2"
    fail=$((fail + 1))
  fi
}

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1

# --- cursor (jq merge; --pre-edit exercises the prefixed-command variant) ---
if [ "$have_jq" -eq 1 ]; then
  d=$(mkdir_scratch)
  sh "$repo/scripts/install-cursor.sh" --pre-edit "$d" >/dev/null 2>&1
  r1_total=$(inspect_hooks "$d/.claude/settings.json" | cut -d' ' -f1)
  sh "$repo/scripts/install-cursor.sh" --pre-edit "$d" >/dev/null 2>&1
  report "install-cursor.sh --pre-edit" "$d/.claude/settings.json"

  # Over-strip regression: a USER hook that merely REFERENCES the reflector path
  # (but is not one of our two exact commands) must survive a reinstall. The
  # dedup must match our exact commands, never any command containing the path.
  python3 - "$d/.claude/settings.json" "$repo/scripts/codex-reflector.py" <<'PY'
import json, sys
f, ref = sys.argv[1], sys.argv[2]
data = json.load(open(f))
data["hooks"].setdefault("PostToolUse", []).append(
    {"hooks": [{"type": "command", "command": f'mylogger python3 "{ref}" --tail'}]}
)
json.dump(data, open(f, "w"))
PY
  sh "$repo/scripts/install-cursor.sh" --pre-edit "$d" >/dev/null 2>&1
  if grep -q 'mylogger' "$d/.claude/settings.json"; then
    printf 'PASS install-cursor.sh preserves a user hook referencing the reflector path\n'
    pass=$((pass + 1))
  else
    printf 'FAIL install-cursor.sh stripped a user hook (dedup over-matched the path)\n'
    fail=$((fail + 1))
  fi
else
  printf 'SKIP install-cursor.sh (jq unavailable)\n'; skip=$((skip + 1))
fi

# --- grok (jq merge; pre-edit always on) ---
if [ "$have_jq" -eq 1 ]; then
  d=$(mkdir_scratch)
  sh "$repo/scripts/install-grok.sh" "$d" >/dev/null 2>&1
  r1_total=$(inspect_hooks "$d/.claude/settings.json" | cut -d' ' -f1)
  sh "$repo/scripts/install-grok.sh" "$d" >/dev/null 2>&1
  report "install-grok.sh" "$d/.claude/settings.json"
else
  printf 'SKIP install-grok.sh (jq unavailable)\n'; skip=$((skip + 1))
fi

# --- codex (python merge, no jq; --preedit exercises the opt-in hook) ---
d=$(mkdir_scratch)
sh "$repo/scripts/install-codex.sh" --preedit "$d" >/dev/null 2>&1
r1_total=$(inspect_hooks "$d/.codex/hooks.json" | cut -d' ' -f1)
sh "$repo/scripts/install-codex.sh" --preedit "$d" >/dev/null 2>&1
report "install-codex.sh --preedit" "$d/.codex/hooks.json"

# --- antigravity (jq merge into a standalone hooks.json) ---
if [ "$have_jq" -eq 1 ]; then
  d=$(mkdir_scratch)
  sh "$repo/scripts/install-antigravity.sh" \
    --settings-path "$d/settings.json" --hooks-path "$d/hooks.json" >/dev/null 2>&1
  r1_total=$(inspect_hooks "$d/hooks.json" | cut -d' ' -f1)
  sh "$repo/scripts/install-antigravity.sh" \
    --settings-path "$d/settings.json" --hooks-path "$d/hooks.json" >/dev/null 2>&1
  report "install-antigravity.sh" "$d/hooks.json"
else
  printf 'SKIP install-antigravity.sh (jq unavailable)\n'; skip=$((skip + 1))
fi

printf '\n%s passed, %s failed, %s skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
