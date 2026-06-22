# Codex Reflector Agent Notes

This file is only for repo-specific constraints that are easy to break and expensive to rediscover. README owns installation and user-facing usage; do not duplicate it here.

## Surface split

- **Rule:** Treat the repository as two hook surfaces, not one implementation. The Claude/Cursor plugin is `scripts/codex-reflector.py` wired by `hooks/hooks.json`; the oh-my-pi port is `omp/codex-reflector.ts` loaded through `package.json` `omp.extensions`.
  **Why:** Both surfaces call `codex exec` and expose the same reflector idea, but their hook delivery and stop-enforcement mechanisms differ. Editing the wrong surface fixes nothing.

- **Rule:** For shared behavior changes, check both surfaces before declaring parity: verdict parsing, prompt builders, redaction/sandboxing, stop-review enforcement, model/effort gating, and changed-file target resolution.
  **Why:** The TypeScript file is a native port of the Python hook, while the OMP tests codify port-specific contracts. Silent drift produces different review outcomes for Claude/Cursor vs OMP users.

## Python Claude/Cursor plugin invariants

- **Rule:** Keep `hooks/hooks.json` as routing glue and keep real classification in `classify()` inside `scripts/codex-reflector.py`. Cursor-specific matcher generation belongs in `scripts/install-cursor.sh`, not in the core dispatch path.
  **Why:** Claude and Cursor expose different hook payloads and matcher behavior. A duplicated routing table becomes a drift source; the Python script normalizes payloads and owns the routing decision.

- **Rule:** Python blocking is exit-code based. Advisory reviews exit `0` with JSON; Stop blocks by returning `decision: "block"`/`_exit: 2`, which `main()` emits on stderr before exiting `2`.
  **Why:** Claude consumes exit `2` stderr as blocking context. Treating Stop like PostToolUse JSON feedback either fails schema validation or silently approves work that should block.

- **Rule:** `hookSpecificOutput` is only for events whose schema accepts it (`PostToolUse`, `PostToolUseFailure`, `PreToolUse`, `UserPromptSubmit`). Stop must use `systemMessage` or `decision`/`reason`; PreCompact must use `systemMessage`.
  **Why:** Stop/PreCompact reject `hookSpecificOutput`; putting it there breaks the hook response instead of injecting useful context.

- **Rule:** Parse verdicts from raw Codex output before any compaction in every responder that branches on PASS/FAIL/UNCERTAIN.
  **Why:** Compaction can remove or rewrite the verdict line. A buried or stripped verdict becomes UNCERTAIN and changes fail-open/fail-closed behavior.

- **Rule:** The Python plugin is stateless — no `.json` FAIL cache and no `fcntl` state file. `respond_code_review`/`respond_plan_review` inject the verdict + opinion inline as `systemMessage` (every verdict), adding `hookSpecificOutput.additionalContext` for FAIL/UNCERTAIN. `respond_stop` is a fresh holistic review run once per stop chain: only a FAIL blocks (`decision: "block"`/`_exit: 2`); PASS and UNCERTAIN settle via `systemMessage` (fail-open — never block on uncertainty), and the retained `stop_hook_active` guard settles a re-stop.
  **Why:** Per-tool reviews self-correct inline; the holistic Stop review is the gate. Python has no continuation cap, so `stop_hook_active` is the only safe loop bound — re-reviewing every stop without it could never settle.

- **Rule:** Keep Cursor payload adaptation contained in `_normalize_cursor_input()` and generated settings from `scripts/install-cursor.sh`.
  **Why:** Cursor compatibility maps event names and fields into Claude-shaped hook data. Scattering Cursor field handling through responders makes every future hook change harder to audit.

## OMP native extension invariants

- **Rule:** The OMP surface is a default-export hook factory. `CODEX_REFLECTOR_ENABLED=0` must register no handlers.
  **Why:** OMP loads the extension through the manifest/factory contract; the kill switch must be safe even when the package is present.

- **Rule:** On successful `tool_result` side-effect reviews (code changes and successful `bash`), return a `content` override carrying the verdict + opinion for every verdict — advisory only; NEVER set `isError`. The per-tool review never blocks the edit/command; the holistic Stop review is the sole gate. On tool error paths, send diagnostics with `pi.sendMessage()` and return `undefined`; the original failed tool call already blocks.
  **Why:** A per-tool `isError: true` would rethrow a *succeeded* edit/command (its side effect already applied) as a failed tool call, misleading the agent about state — per-tool reviews are advice, not gates. Overriding a genuine error result would corrupt the harness error path and can drop the diagnostic, so error paths stay on `pi.sendMessage`.

- **Rule:** The OMP extension is stateless — no `FailTracker`, no `appendEntry` FAIL entries, no `session_start` replay. `tool_result` side-effect reviews inject their verdict + opinion inline via `codeReviewResponse` for every verdict (PASS included) and are advisory only — no verdict sets `isError`, so a per-tool review never blocks. This matches the Python plugin's per-tool model (advisory `hookSpecificOutput.additionalContext`); on both surfaces only the holistic Stop review blocks.
  **Why:** Per-tool reviews surface inline as advice; blocking a succeeded edit/command at `tool_result` is wrong because the side effect already happened. Enforcement belongs to the holistic Stop review (OMP via `{ decision: "block", reason }`, Python via exit `2`), so the two surfaces agree on per-tool advisory and differ only in the Stop mechanism.

- **Rule:** The OMP Stop gate is a fresh holistic review on the native `session_stop` event (main-session-only, awaited before settle), centralized in the pure `stopReviewDecision` helper: only a FAIL blocks and returns `{ decision: "block", reason }` (Claude/Codex-compatible shape, matching the Python plugin); PASS and UNCERTAIN settle (fail-open — never block on uncertainty). Settle SILENTLY — return `undefined` and inject NO conversation message: surfacing the verdict via `pi.sendMessage` (even with `triggerTurn:false`) re-enters the conversation, so the agent takes a turn on it and re-stops, looping the Stop on every PASS up to the continuation cap; use `notifyUI` for a non-conversation notice. Re-run it on every settle attempt (no `stop_hook_active` guard, no cache fast-path, no per-file dedup), and rely on oh-my-pi's built-in 8-continuation cap — do not reimplement a port-side loop counter. A one-shot review would let a FAIL settle on the next stop.
  **Why:** `session_stop` (omp 16.0.5, #2834) is the main-agent Stop analog; `agent_end` also fires for subagent sessions and its return value is ignored. The harness owns loop protection, so a port-side cap is redundant drift. The silent-settle clause is a surface difference: the Python plugin returns a PASS as `{systemMessage}` at exit 0 (Claude renders it as non-blocking display and settles), but OMP's `pi.sendMessage` injects a conversation message that continues the agent — so the OMP settle path surfaces non-FAIL verdicts via `notifyUI`, never `sendMessage`.

- **Rule:** Pre-compaction reflection is advisory only.
  **Why:** The hook should surface metacognition before compaction without mutating the compaction operation or session state.

- **Rule:** Every `invokeCodex` call inside an OMP handler MUST receive a shared per-handler `handlerDeadline()` signal (`HANDLER_BUDGET_MS`, kept under oh-my-pi's fixed 30s `EXTENSION_HANDLER_TIMEOUT_MS`), threaded through `compactSnippet`/`matryoshkaCompact` and the async prompt builders, with `deadline.clear()` in a `finally`. `invokeCodex`'s own `CODEX_TIMEOUT_MS` stays under that cap too.
  **Why:** The harness caps a handler at 30s via `Promise.race` without aborting it, so a hung `codex` child outlives the cap — the review is dropped and the child is orphaned (the `handler timed out after 30000ms` failure mode). The shared deadline SIGKILLs the child and fails the handler open before the cap. OMP-only: the Python plugin's Claude-hook timeouts (>=120s) sit above its 100s guard, so no 30s race exists there.

## Safety invariants

- **Rule:** Redact secrets before sending prompts to Codex, and keep untrusted tool/transcript data sandboxed where that prompt path supports sandbox wrappers. Keep `codex exec` read-only/ephemeral and fail-open on invocation errors.
  **Why:** The reflector reviews arbitrary tool output, diffs, shell errors, and transcripts. Codex must not receive credentials, treat untrusted data as instructions, modify the repo, or brick the agent when external infrastructure fails.
