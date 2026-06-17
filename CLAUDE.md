# Codex Reflector Agent Notes

This file is only for repo-specific constraints that are easy to break and expensive to rediscover. README owns installation and user-facing usage; do not duplicate it here.

## Surface split

- **Rule:** Treat the repository as two hook surfaces, not one implementation. The Claude/Cursor plugin is `scripts/codex-reflector.py` wired by `hooks/hooks.json`; the oh-my-pi port is `omp/codex-reflector.ts` loaded through `package.json` `omp.extensions`.
  **Why:** Both surfaces call `codex exec` and expose the same reflector idea, but their hook delivery, state persistence, and stop-enforcement mechanisms differ. Editing the wrong surface fixes nothing.

- **Rule:** For shared behavior changes, check both surfaces before declaring parity: verdict parsing, prompt builders, redaction/sandboxing, fail-state semantics, model/effort gating, and changed-file target resolution.
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

- **Rule:** Python FAIL state is per session and per target file, guarded by `fcntl.flock`. FAIL records state, PASS clears it, and UNCERTAIN must not mutate it. Stop first blocks on unresolved recorded FAILs; a Stop-review UNCERTAIN is fail-closed and blocks.
  **Why:** Individual reviews are advisory, but Stop is the accumulation checkpoint. Clearing state on UNCERTAIN hides unresolved FAILs from that checkpoint.

- **Rule:** Keep Cursor payload adaptation contained in `_normalize_cursor_input()` and generated settings from `scripts/install-cursor.sh`.
  **Why:** Cursor compatibility maps event names and fields into Claude-shaped hook data. Scattering Cursor field handling through responders makes every future hook change harder to audit.

## OMP native extension invariants

- **Rule:** The OMP surface is a default-export hook factory. `CODEX_REFLECTOR_ENABLED=0` must register no handlers.
  **Why:** OMP loads the extension through the manifest/factory contract; the kill switch must be safe even when the package is present.

- **Rule:** On successful `tool_result` reviews, return a `content` override. On tool error paths, send diagnostics with `pi.sendMessage()` and return `undefined`.
  **Why:** OMP rethrows tool errors. Overriding error results would corrupt the harness error path instead of preserving the original failure.

- **Rule:** OMP FAIL state lives in `FailTracker` and is replayed from `codex-reflector-fail` custom entries. Open per-file generation tokens before awaiting Codex; drop a combined review if any target path has gone stale; dedupe multi-file `ast_edit` paths.
  **Why:** Reviews race with later edits. Per-path generations prevent old Codex output from overwriting newer state, and deduping avoids self-superseding a single edit.

- **Rule:** Do not port Python's exit-2 Stop veto into OMP. OMP enforces unresolved FAILs and Stop-review FAIL/UNCERTAIN through bounded `agent_end` follow-up messages (`REENGAGE_CAP`).
  **Why:** OMP has no Claude Stop stderr veto path; re-engagement is the enforcement channel, and the cap prevents infinite loops.

- **Rule:** Pre-compaction reflection is advisory only.
  **Why:** The hook should surface metacognition before compaction without mutating the compaction operation or session state.

## Safety invariants

- **Rule:** Redact secrets before sending prompts to Codex, and keep untrusted tool/transcript data sandboxed where that prompt path supports sandbox wrappers. Keep `codex exec` read-only/ephemeral and fail-open on invocation errors.
  **Why:** The reflector reviews arbitrary tool output, diffs, shell errors, and transcripts. Codex must not receive credentials, treat untrusted data as instructions, modify the repo, or brick the agent when external infrastructure fails.
