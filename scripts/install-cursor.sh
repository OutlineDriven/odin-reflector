#!/bin/sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 [--force] [target-project-dir]"
  printf '%s\n' ""
  printf '%s\n' "Installs Cursor third-party Claude hook settings for codex-reflector."
  printf '%s\n' "Without target-project-dir, writes to ~/.claude/settings.json."
  printf '%s\n' "With target-project-dir, writes to target-project-dir/.claude/settings.json."
}

force=0
target_root=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=1
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
codex_command="python3 \"${reflector_script}\""

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

python3 - "$reflector_script" > "$tmp_new" <<'PY'
import json
import sys

script = sys.argv[1]
command = f'python3 "{script}"'

settings = {
    "hooks": {
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
}

print(json.dumps(settings, indent=2))
PY

mkdir -p "$settings_dir"

if [ -f "$settings_path" ] && [ "$force" -ne 1 ]; then
  if command -v jq >/dev/null 2>&1; then
    jq --arg codex_command "$codex_command" -s '
      def without_codex($command):
        map(
          if has("hooks") then
            . + {hooks: (.hooks | map(select((.command // "") != $command)))}
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
              (($existing.hooks[$key] // []) | without_codex($codex_command))
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
