#!/bin/sh
# Antigravity (agy) plugin-dir hook wrapper for codex-reflector (U11).
#
# Sets the Antigravity host then execs the reflector. Putting
# REFLECTOR_HOST=antigravity here (NOT as an inline `VAR=val cmd` env-prefix in
# the hooks.json `command` string) makes env-setting independent of whether agy
# shell-interprets the command — it relies only on single-variable
# ${CLAUDE_PLUGIN_ROOT} expansion (mirrors hooks/codex-reflector-hook.sh).
#
# REFLECTOR_HOST=antigravity is LOAD-BEARING for B5: it pins the host so the
# namespaced /tmp fail-state file (codex-reflector-fails-antigravity-{sid}.json)
# written at PostToolUse is READ at Stop under the SAME namespace — a Stop payload
# carries no workspacePaths, so without the pin resolve_host() would infer
# "claude" at Stop and read the wrong (bare) file, silently losing the FAIL.
export REFLECTOR_HOST=antigravity
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
exec python3 "${plugin_root}/scripts/codex-reflector.py" "$@"
