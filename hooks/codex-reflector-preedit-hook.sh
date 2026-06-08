#!/bin/sh
# Codex plugin-dir OPT-IN pre-edit hook wrapper for codex-reflector (U8/KTD-12).
#
# Same as codex-reflector-hook.sh but also enables the pre-edit hard-block
# (REFLECTOR_PREEDIT_BLOCK=1). Referenced only by the opt-in
# hooks/codex-hooks-preedit.json fragment, never the default wiring.
export REFLECTOR_HOST=codex
export REFLECTOR_PREEDIT_BLOCK=1
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
exec python3 "${plugin_root}/scripts/codex-reflector.py" "$@"
