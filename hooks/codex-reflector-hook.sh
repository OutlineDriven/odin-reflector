#!/bin/sh
# Codex plugin-dir hook wrapper for codex-reflector (U8).
#
# Sets the Codex host then execs the reflector. Putting REFLECTOR_HOST=codex here
# (not as an inline `VAR=val cmd` env-prefix in the hooks.json `command` string)
# makes env-setting independent of whether Codex shell-interprets the command —
# it relies only on single-variable ${CLAUDE_PLUGIN_ROOT} expansion, which Codex
# documents it sets "for compatibility with existing plugin hooks". REFLECTOR_HOST
# =codex is what makes the host normalizer re-emit PostToolUseFailure on error
# payloads (B4), keeping the failure-diagnostic flow live on Codex.
#
# CLAUDE_PLUGIN_ROOT (compat) is preferred; PLUGIN_ROOT (Codex-native) is the
# fallback. install-codex.sh generates its OWN absolute-path wrapper for the
# ~/.codex/hooks.json merge path and does not use this file.
export REFLECTOR_HOST=codex
plugin_root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
exec python3 "${plugin_root}/scripts/codex-reflector.py" "$@"
