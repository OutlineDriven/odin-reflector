#!/bin/sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 [--force] [--pre-edit] [target-project-dir]"
  printf '%s\n' ""
  printf '%s\n' "Installs Cursor third-party Claude hook settings for codex-reflector."
  printf '%s\n' "Without target-project-dir, writes to ~/.claude/settings.json."
  printf '%s\n' "With target-project-dir, writes to target-project-dir/.claude/settings.json."
  printf '%s\n' ""
  printf '%s\n' "--pre-edit  Also wire the opt-in PreToolUse pre-edit deny gate (maps via"
  printf '%s\n' "            Cursor's preToolUse). The hook still self-gates on"
  printf '%s\n' "            REFLECTOR_PREEDIT_BLOCK at runtime, so it is inert unless enabled."
}

force=0
pre_edit=0
target_root=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=1
      shift
      ;;
    --pre-edit)
      pre_edit=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf '%s\n' "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$target_root" ]; then
        printf '%s\n' "Only one target-project-dir may be provided." >&2
        usage >&2
        exit 2
      fi
      target_root=$1
      shift
      ;;
  esac
done

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
plugin_root=$(dirname -- "$script_dir")
reflector_script="${plugin_root}/scripts/codex-reflector.py"
# The two EXACT hook commands this installer emits (must byte-match what the
# python heredoc generates): the bare post-event command and the pre-edit
# variant. The merge strips exactly these so reinstall is idempotent WITHOUT
# clobbering a user's own hooks that merely mention the reflector path.
codex_command="python3 \"${reflector_script}\""
pre_edit_command="REFLECTOR_PREEDIT_BLOCK=1 ${codex_command}"

if [ ! -f "$reflector_script" ]; then
  printf '%s\n' "Cannot find codex-reflector.py at: $reflector_script" >&2
  exit 1
fi

if [ -n "$target_root" ]; then
  settings_dir="${target_root%/}/.claude"
else
  settings_dir="${HOME}/.claude"
fi

settings_path="${settings_dir}/settings.json"
tmp_new=$(mktemp)
tmp_merged=$(mktemp)
trap 'rm -f "$tmp_new" "$tmp_merged"' EXIT INT HUP TERM

python3 - "$reflector_script" "$pre_edit" > "$tmp_new" <<'PY'
import json
import sys

script = sys.argv[1]
pre_edit = len(sys.argv) > 2 and sys.argv[2] == "1"
command = f'python3 "{script}"'

hooks = {
    "PostToolUse": [
        {
            "matcher": "Write|Edit|MultiEdit|Patch|NotebookEdit|ExitPlanMode|mcp__.*morph.*|mcp__.*edit.*|mcp__.*edit_file.*|mcp__.*sequentialthinking.*|mcp__.*sequential_thinking.*|mcp__.*actor-critic.*|mcp__.*shannon.*",
            "hooks": [
                {"type": "command", "command": command, "timeout": 240},
            ],
        }
    ],
    "PostToolUseFailure": [
        {
            "hooks": [
                {"type": "command", "command": command, "timeout": 120},
            ],
        }
    ],
    "Stop": [
        {
            "hooks": [
                {"type": "command", "command": command, "timeout": 240},
            ],
        }
    ],
    "PreCompact": [
        {
            "hooks": [
                {"type": "command", "command": command, "timeout": 240},
            ],
        }
    ],
}

if pre_edit:
    # Opt-in pre-edit deny gate (maps via Cursor's preToolUse). Synchronous —
    # the edit waits on it — so a shorter timeout than the post-event hooks. The
    # --pre-edit flag SETS REFLECTOR_PREEDIT_BLOCK=1 inline so the gate is actually
    # ACTIVE (Cursor runs hook commands through a shell, like grok/codex);
    # respond_pretooluse still self-gates on it, and the default install (no
    # --pre-edit) wires no PreToolUse hook at all.
    pre_edit_command = f"REFLECTOR_PREEDIT_BLOCK=1 {command}"
    hooks["PreToolUse"] = [
        {
            "matcher": "Write|Edit|MultiEdit|Patch|NotebookEdit|mcp__.*edit.*|mcp__.*morph.*",
            "hooks": [
                {"type": "command", "command": pre_edit_command, "timeout": 120},
            ],
        }
    ]

print(json.dumps({"hooks": hooks}, indent=2))
PY

mkdir -p "$settings_dir"

if [ -f "$settings_path" ] && [ "$force" -ne 1 ]; then
  if command -v jq >/dev/null 2>&1; then
    jq --arg cmd "$codex_command" --arg precmd "$pre_edit_command" -s '
      # Strip ONLY our two exact generated commands (bare + pre-edit variant),
      # so reinstall is idempotent for both --pre-edit and plain runs WITHOUT
      # clobbering a user-authored hook that merely references the reflector path.
      def without_reflector($cmd; $precmd):
        map(
          if has("hooks") then
            . + {hooks: (.hooks | map(select((.command // "") as $c | $c != $cmd and $c != $precmd)))}
          else
            .
          end
        )
        | map(select((has("hooks") | not) or ((.hooks // []) | length > 0)));

      .[0] as $existing
      | .[1] as $codex
      | (($existing.hooks // {}) + ($codex.hooks // {}) | keys_unsorted | unique) as $keys
      | $existing + {
          hooks: reduce $keys[] as $key ({};
            .[$key] = (
              (($existing.hooks[$key] // []) | without_reflector($cmd; $precmd))
              + ($codex.hooks[$key] // [])
            )
          )
        }
    ' "$settings_path" "$tmp_new" > "$tmp_merged"
    mv "$tmp_merged" "$settings_path"
    printf '%s\n' "Merged codex-reflector hooks into $settings_path"
    exit 0
  fi

  printf '%s\n' "Refusing to overwrite existing $settings_path because jq is unavailable." >&2
  printf '%s\n' "Install jq to merge automatically, or rerun with --force to replace the file." >&2
  exit 1
fi

mv "$tmp_new" "$settings_path"
printf '%s\n' "Installed codex-reflector hooks to $settings_path"
