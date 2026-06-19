import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import codexReflector, {
	changeSizeHeuristics,
	classify,
	codeReviewResponse,
	fileHeuristics,
	gateModelEffort,
	handlerDeadline,
	HANDLER_BUDGET_MS,
	notifyUI,
	parseVerdict,
	redact,
	renderTranscript,
	resolveChangeTarget,
	sandboxContent,
	stopReviewDecision,
	testSetHandlerBudgetMs,
} from "./codex-reflector.ts";

/** Poll until `pid` no longer exists (kill(pid,0) → ESRCH), bounded by timeoutMs.
 *  invokeCodex resolves on abort before the child's close event fires, so a
 *  SIGKILLed child may briefly linger; poll rather than checking once. */
async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true; // ESRCH — process is gone
		}
		await Bun.sleep(25);
	}
	return false;
}

describe("parseVerdict", () => {
	const cases: ReadonlyArray<[string, "PASS" | "FAIL" | "UNCERTAIN"]> = [
		["PASS", "PASS"],
		["FAILED: missing null check", "FAIL"],
		["verdict: pass", "PASS"],
		["verdict=FAIL", "FAIL"],
		["**PASS**", "PASS"],
		["✅ PASS", "PASS"],
		["❌ FAIL", "FAIL"],
		["LGTM", "PASS"],
		["REJECTED", "FAIL"],
		["PASS\nFAIL", "UNCERTAIN"], // contradictory
		["", "UNCERTAIN"],
		["random text\nno verdict here", "UNCERTAIN"],
		["l1\nl2\nl3\nl4\nl5\nPASS", "UNCERTAIN"], // verdict buried past the 5-line window
	];
	for (const [raw, expected] of cases) {
		test(`${JSON.stringify(raw)} -> ${expected}`, () => {
			expect(parseVerdict(raw)).toBe(expected);
		});
	}
});

describe("classify", () => {
	test("native mutators -> code_change", () => {
		expect(classify("write", false)?.category).toBe("code_change");
		expect(classify("edit", false)?.category).toBe("code_change");
		expect(classify("ast_edit", false)?.category).toBe("code_change");
	});
	test("bash failure -> bash_failure, bash success -> bash_success", () => {
		expect(classify("bash", true)?.category).toBe("bash_failure");
		expect(classify("bash", false)?.category).toBe("bash_success");
	});
	test("non-reviewed tools -> null", () => {
		expect(classify("read", false)).toBeNull();
		expect(classify("task", false)).toBeNull();
		expect(classify("search", false)).toBeNull();
	});
	test("thinking MCP -> thinking", () => {
		expect(classify("mcp__sequential__sequentialthinking", false)?.category).toBe("thinking");
		expect(classify("mcp__shannon__shannon", false)?.category).toBe("thinking");
	});
	test("Fast-Apply MCP success -> code_change", () => {
		expect(classify("mcp__morph__edit_file", false)?.category).toBe("code_change");
	});
	test("Fast-Apply MCP failure WITH Morph payload -> code_change_failure", () => {
		expect(
			classify("mcp__morph__edit_file", true, { code_edit: "x", instruction: "y" })?.category,
		).toBe("code_change_failure");
	});
	test("Fast-Apply MCP failure WITHOUT payload -> null (name match alone is insufficient)", () => {
		expect(classify("mcp__morph__edit_file", true)).toBeNull();
		expect(classify("mcp__morph__edit_file", true, { code_edit: "", instruction: "" })).toBeNull();
		expect(classify("mcp__morph__edit_file", true, { code_edit: "x" })).toBeNull();
	});
});

describe("redact", () => {
	test("strips api keys / tokens / bearer", () => {
		expect(redact("api_key=sk-deadbeefcafebabe1234")).toContain("[REDACTED]");
		expect(redact("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
		expect(redact("token ghp_0123456789abcdefghijklmn")).toContain("[REDACTED]");
	});
	test("leaves clean text untouched", () => {
		expect(redact("just some harmless prose")).toBe("just some harmless prose");
	});
	test("strips OpenSSH / PGP private-key blocks and bare AWS key ids (SEC-R3)", () => {
		expect(
			redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"),
		).toContain("[REDACTED]");
		expect(
			redact("-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----"),
		).toContain("[REDACTED]");
		expect(redact("creds: AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED]");
	});
});

describe("fileHeuristics", () => {
	test("security-sensitive paths", () => {
		expect(fileHeuristics(".env.local")[0]).toContain("SECURITY-SENSITIVE");
	});
	test("test / ui / data / config classification", () => {
		expect(fileHeuristics("foo_test.ts").some((f) => f.startsWith("TEST FILE"))).toBe(true);
		expect(fileHeuristics("page.tsx").some((f) => f.startsWith("UI FILE"))).toBe(true);
		expect(fileHeuristics("schema.sql").some((f) => f.startsWith("DATA FILE"))).toBe(true);
		expect(fileHeuristics("app.config.json").some((f) => f.startsWith("CONFIG FILE"))).toBe(true);
	});
	test("plain source path has no focuses", () => {
		expect(fileHeuristics("src/util.ts")).toHaveLength(0);
	});
});

describe("changeSizeHeuristics", () => {
	test("large content", () => {
		const hints = changeSizeHeuristics(6000);
		expect(hints).toHaveLength(1);
		expect(hints[0]).toContain("LARGE CONTENT");
	});
	test("expansion when new >> old", () => {
		expect(changeSizeHeuristics(50, 10, 100)[0]).toContain("SIGNIFICANT EXPANSION");
	});
	test("reduction when new << old", () => {
		expect(changeSizeHeuristics(50, 100, 10)[0]).toContain("SIGNIFICANT REDUCTION");
	});
	test("no signals for small symmetric change", () => {
		expect(changeSizeHeuristics(50, 100, 90)).toHaveLength(0);
	});
});

describe("gateModelEffort", () => {
	test("tiny non-risky snippet -> low", () => {
		expect(gateModelEffort("code_change", "src/util.ts", "const x = 1;").effort).toBe("low");
	});
	test("security-sensitive path -> hard (high)", () => {
		expect(gateModelEffort("code_change", ".env.local", "X".repeat(300)).effort).toBe("high");
	});
	test("large snippet -> hard (high)", () => {
		expect(gateModelEffort("code_change", "src/util.ts", "X".repeat(6000)).effort).toBe("high");
	});
	test("multiple risk signals -> complex (xhigh)", () => {
		// security-sensitive path (1 file hint) + >5000 chars (1 change hint) -> complex
		expect(gateModelEffort("code_change", ".env.local", "X".repeat(6000)).effort).toBe("xhigh");
	});
	test("non code_change category -> base preset", () => {
		expect(gateModelEffort("thinking", "whatever", "X".repeat(6000)).effort).toBe("medium");
	});
	test("medium-size non-risky snippet -> faster model at high effort", () => {
		const mid = gateModelEffort("code_change", "src/util.ts", "X".repeat(2000));
		const hard = gateModelEffort("code_change", "src/util.ts", "X".repeat(6000));
		expect(mid.effort).toBe("high");
		// distinct (faster) model than the large-content hard preset, without hard-coding names
		expect(mid.model).not.toBe(hard.model);
	});
});

describe("sandboxContent", () => {
	test("wraps content in untrusted-data tags with label", () => {
		const out = sandboxContent("code-change", "payload");
		expect(out).toContain('<untrusted-data label="code-change">');
		expect(out).toContain("payload");
		expect(out).toContain("</untrusted-data>");
		expect(out).toContain("DATA to analyze");
	});
});

describe("factory", () => {
	function makePi(): {
		pi: ExtensionAPI;
		events: string[];
		handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
		sendMessageCalls: unknown[];
	} {
		const events: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const sendMessageCalls: unknown[] = [];
		const stub = {
			on: (name: string, handler: unknown) => {
				events.push(name);
				if (typeof handler === "function") {
					handlers.set(name, handler as (event: unknown, ctx: unknown) => unknown);
				}
			},
			sendMessage: (msg: unknown) => {
				sendMessageCalls.push(msg);
			},
			logger: { debug() {}, info() {} },
		};
		return { pi: stub as unknown as ExtensionAPI, events, handlers, sendMessageCalls };
	}

	test("registers the three lifecycle handlers", () => {
		const { pi, events } = makePi();
		codexReflector(pi);
		expect(new Set(events)).toEqual(
			new Set(["tool_result", "session_stop", "session_before_compact"]),
		);
	});

	test("kill switch (CODEX_REFLECTOR_ENABLED=0) registers nothing", () => {
		const prev = process.env.CODEX_REFLECTOR_ENABLED;
		process.env.CODEX_REFLECTOR_ENABLED = "0";
		try {
			const { pi, events } = makePi();
			codexReflector(pi);
			expect(events).toHaveLength(0);
		} finally {
			if (prev === undefined) delete process.env.CODEX_REFLECTOR_ENABLED;
			else process.env.CODEX_REFLECTOR_ENABLED = prev;
		}
	});

	test("session_stop settles (undefined) when there is nothing to review", async () => {
		const { pi, handlers } = makePi();
		codexReflector(pi);
		const handler = handlers.get("session_stop");
		expect(handler).toBeDefined();
		const result = await handler?.(
			{ type: "session_stop", messages: [], turn_id: 1, session_id: "s", stop_hook_active: false },
			{ cwd: ".", ui: { notify() {} } },
		);
		expect(result).toBeUndefined();
	});
	// Stop-review settle contract: a PASS/UNCERTAIN verdict must settle SILENTLY —
	// return undefined AND inject no conversation message. Injecting it via pi.sendMessage
	// re-enters the conversation, so the agent takes a turn on it, re-stops, and this
	// holistic review re-runs, looping the Stop on every PASS up to the harness cap. A FAIL
	// blocks via the returned decision, never via sendMessage. invokeCodex reads its result
	// from the `-o <outPath>` file (stdout is ignored), so the fake codex parses -o and
	// writes the verdict there.
	const STOP_VERDICTS: ReadonlyArray<{ name: string; out: string; blocks: boolean }> = [
		{ name: "PASS", out: "PASS", blocks: false },
		{ name: "UNCERTAIN", out: "still investigating", blocks: false },
		{ name: "FAIL", out: "FAIL: missing guard", blocks: true },
	];
	for (const c of STOP_VERDICTS) {
		test(`session_stop ${c.name} ${c.blocks ? "blocks via decision" : "settles"} without sendMessage`, async () => {
			const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
			writeFileSync(
				join(binDir, "codex"),
				`#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n[ -n "$out" ] && printf '%s\\n' ${JSON.stringify(c.out)} > "$out"\nexit 0\n`,
			);
			chmodSync(join(binDir, "codex"), 0o755);
			const prevPath = process.env.PATH ?? "";
			process.env.PATH = `${binDir}:${prevPath}`;
			try {
				const { pi, handlers, sendMessageCalls } = makePi();
				codexReflector(pi);
				const handler = handlers.get("session_stop");
				expect(handler).toBeDefined();
				const result = (await handler?.(
					{
						type: "session_stop",
						messages: [
							{ role: "user", content: "hi" },
							{ role: "assistant", content: "did work" },
						],
						turn_id: 1,
						session_id: "s",
						stop_hook_active: false,
					},
					{ cwd: ".", hasUI: false, ui: { notify() {} } },
				)) as { decision?: string; reason?: string } | undefined;
				if (c.blocks) {
					expect(result?.decision).toBe("block");
					expect(result?.reason).toContain("FAIL");
				} else {
					expect(result).toBeUndefined();
				}
				expect(sendMessageCalls).toHaveLength(0);
			} finally {
				process.env.PATH = prevPath;
				rmSync(binDir, { recursive: true, force: true });
			}
		}, 15_000);
	}
	// Per-tool code-review is advisory: every verdict (PASS/UNCERTAIN/FAIL) rides along as
	// appended content and NONE sets isError, so a succeeded edit/command is never blocked.
	// Enforcement lives in the holistic session_stop review (see STOP_VERDICTS), not here.
	// The fake codex writes the verdict to the -o file (invokeCodex ignores stdout).
	const CODE_REVIEW_VERDICTS: ReadonlyArray<{ name: string; out: string }> = [
		{ name: "PASS", out: "PASS" },
		{ name: "UNCERTAIN", out: "still investigating" },
		{ name: "FAIL", out: "FAIL: missing guard" },
	];
	for (const c of CODE_REVIEW_VERDICTS) {
		test(`tool_result code_change ${c.name} stays advisory`, async () => {
			const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
			writeFileSync(
				join(binDir, "codex"),
				`#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n[ -n "$out" ] && printf '%s\\n' ${JSON.stringify(c.out)} > "$out"\nexit 0\n`,
			);
			chmodSync(join(binDir, "codex"), 0o755);
			const prevPath = process.env.PATH ?? "";
			process.env.PATH = `${binDir}:${prevPath}`;
			try {
				const { pi, handlers } = makePi();
				codexReflector(pi);
				const handler = handlers.get("tool_result");
				expect(handler).toBeDefined();
				const event = {
					type: "tool_result",
					toolName: "write",
					toolCallId: "id",
					input: { path: "x.ts", content: "const a = 1;" },
					content: [],
					isError: false,
				} as unknown as Parameters<NonNullable<typeof handler>>[0];
				const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
					NonNullable<typeof handler>
				>[1];
				const result = (await handler?.(event, ctx)) as
					| { content?: Array<{ type: string; text: string }>; isError?: boolean }
					| undefined;
				expect(result).toBeDefined();
				expect(result?.isError).toBeFalsy();
				const last = result?.content?.at(-1);
				expect(last?.type).toBe("text");
				expect(last?.text).toContain(c.name);
			} finally {
				process.env.PATH = prevPath;
				rmSync(binDir, { recursive: true, force: true });
			}
		}, 15_000);
	}
	// Successful bash command review: same PASS/UNCERTAIN/FAIL contract as code_change.
	const BASH_REVIEW_VERDICTS: ReadonlyArray<{ name: string; out: string }> = [
		{ name: "PASS", out: "PASS" },
		{ name: "UNCERTAIN", out: "still investigating" },
		{ name: "FAIL", out: "FAIL: leaked secret" },
	];
	for (const c of BASH_REVIEW_VERDICTS) {
		test(`tool_result bash_success ${c.name} stays advisory`, async () => {
			const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
			writeFileSync(
				join(binDir, "codex"),
				`#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n[ -n "$out" ] && printf '%s\\n' ${JSON.stringify(c.out)} > "$out"\nexit 0\n`,
			);
			chmodSync(join(binDir, "codex"), 0o755);
			const prevPath = process.env.PATH ?? "";
			process.env.PATH = `${binDir}:${prevPath}`;
			try {
				const { pi, handlers } = makePi();
				codexReflector(pi);
				const handler = handlers.get("tool_result");
				expect(handler).toBeDefined();
				const event = {
					type: "tool_result",
					toolName: "bash",
					toolCallId: "id",
					input: { command: "ls" },
					content: [{ type: "text", text: "ok" }],
					isError: false,
				} as unknown as Parameters<NonNullable<typeof handler>>[0];
				const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
					NonNullable<typeof handler>
				>[1];
				const result = (await handler?.(event, ctx)) as
					| { content?: Array<{ type: string; text: string }>; isError?: boolean }
					| undefined;
				expect(result).toBeDefined();
				expect(result?.isError).toBeFalsy();
				expect(result?.content).toHaveLength(2);
				expect(result?.content?.[0]).toEqual({ type: "text", text: "ok" });
				const last = result?.content?.at(-1);
				expect(last?.type).toBe("text");
				expect(last?.text).toContain(c.name);
			} finally {
				process.env.PATH = prevPath;
				rmSync(binDir, { recursive: true, force: true });
			}
		}, 15_000);
	}
	test("tool_result fails open when codex hangs (deadline SIGKILLs the child)", async () => {
		const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
		const fake = join(binDir, "codex");
		const pidFile = join(binDir, "codex.pid");
		// echo $$ before exec so the pid file holds the (exec-preserved) sleep PID.
		writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
		chmodSync(fake, 0o755);
		const prevPath = process.env.PATH ?? "";
		process.env.PATH = `${binDir}:${prevPath}`;
		testSetHandlerBudgetMs(300); // deadline fires at 300ms (> spawn+log, << the 5s assert / 25s guard)
		try {
			const { pi, handlers } = makePi();
			codexReflector(pi);
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();
			const event = {
				type: "tool_result",
				toolName: "write",
				toolCallId: "id",
				input: { path: "x.ts", content: "const a = 1;" },
				content: [],
				isError: false,
			} as unknown as Parameters<NonNullable<typeof handler>>[0];
			const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
				NonNullable<typeof handler>
			>[1];
			const start = Date.now();
			const result = await handler?.(event, ctx);
			const elapsed = Date.now() - start;
			expect(result).toBeUndefined(); // fail-open: no review override
			expect(elapsed).toBeLessThan(5_000); // 100ms deadline fired, not the 25s guard
			// The deadline must actually SIGKILL the spawned child, not merely resolve.
			expect(existsSync(pidFile)).toBe(true);
			const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
			expect(Number.isInteger(pid)).toBe(true);
			expect(await waitForPidGone(pid, 4_000)).toBe(true);
		} finally {
			process.env.PATH = prevPath;
			testSetHandlerBudgetMs(HANDLER_BUDGET_MS);
			rmSync(binDir, { recursive: true, force: true });
		}
	}, 15_000);
	test("tool_result deadline also aborts the matryoshka compaction codex call", async () => {
		// A snippet > MAX_COMPACT_CHARS (400_000) forces compactSnippet → matryoshkaCompact →
		// codex, exercising the *indirect* codex path. A non-empty invoke log proves matryoshka
		// actually spawned codex (not a tautological early return); drop the signal forwarding into
		// matryoshkaCompact and that hung call blocks on the 25s CODEX_TIMEOUT, blowing the 15s
		// timeout. (The later review call is killed by invokeCodex's post-spawn aborted check
		// regardless of the line-350 early-spawn guard, so this does not exercise that guard.)
		const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
		const invokeLog = join(binDir, "invoked.log");
		writeFileSync(join(binDir, "codex"), `#!/bin/sh\necho $$ >> "${invokeLog}"\nexec sleep 30\n`);
		chmodSync(join(binDir, "codex"), 0o755);
		const prevPath = process.env.PATH ?? "";
		process.env.PATH = `${binDir}:${prevPath}`;
		testSetHandlerBudgetMs(300); // > redact+spawn of the 420K snippet, << the 5s assert / 25s guard
		try {
			const { pi, handlers } = makePi();
			codexReflector(pi);
			const handler = handlers.get("tool_result");
			expect(handler).toBeDefined();
			const event = {
				type: "tool_result",
				toolName: "write",
				toolCallId: "id",
				input: { path: "big.ts", content: "a".repeat(420_000) },
				content: [],
				isError: false,
			} as unknown as Parameters<NonNullable<typeof handler>>[0];
			const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
				NonNullable<typeof handler>
			>[1];
			const start = Date.now();
			const result = await handler?.(event, ctx);
			const elapsed = Date.now() - start;
			expect(result).toBeUndefined();
			expect(elapsed).toBeLessThan(5_000);
			expect(existsSync(invokeLog)).toBe(true); // matryoshka actually invoked codex (indirect path)
			for (const line of readFileSync(invokeLog, "utf8").split("\n")) {
				const pid = Number.parseInt(line.trim(), 10);
				if (Number.isInteger(pid)) expect(await waitForPidGone(pid, 4_000)).toBe(true);
			}
		} finally {
			process.env.PATH = prevPath;
			testSetHandlerBudgetMs(HANDLER_BUDGET_MS);
			rmSync(binDir, { recursive: true, force: true });
		}
	}, 15_000);

	// Every handler route with its own final invokeCodex(..., signal) call must fail open under
	// the deadline when codex hangs. Drop the signal arg from any one route's call and invokeCodex
	// gets no extraSignal — neither the early guard (codex-reflector.ts:350) nor the post-spawn
	// kill (:395-402) runs — so that route blocks on the 25s CODEX_TIMEOUT and blows the 15s
	// timeout. The invoke-log assertion guards against a mis-shaped event short-circuiting to
	// undefined before reaching invokeCodex (which would pass tautologically).
	const HANGING_ROUTES: ReadonlyArray<{ label: string; handler: string; event: Record<string, unknown> }> = [
		{
			label: "tool_result/thinking",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "mcp__sequentialthinking", toolCallId: "id", input: { thought: "x" }, content: [], isError: false },
		},
		{
			label: "tool_result/bash_failure",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "bash", toolCallId: "id", input: { command: "ls" }, content: [{ type: "text", text: "boom" }], isError: true },
		},
		{
			label: "tool_result/bash_success",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "bash", toolCallId: "id", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false },
		},
		{
			label: "tool_result/code_change_failure",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "mcp__morph__edit_file", toolCallId: "id", input: { path: "x.ts", code_edit: "EDIT", instruction: "DO" }, content: [], isError: true },
		},
		{
			label: "session_stop (nonempty transcript)",
			handler: "session_stop",
			event: { type: "session_stop", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "did work" }], turn_id: 1, session_id: "s", stop_hook_active: false },
		},
		{
			label: "session_before_compact (nonempty transcript)",
			handler: "session_before_compact",
			event: { type: "session_before_compact", preparation: { messagesToSummarize: [{ role: "user", content: "work to reflect on" }] } },
		},
	];
	for (const route of HANGING_ROUTES) {
		test(`route ${route.label} fails open when codex hangs`, async () => {
			const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
			const invokeLog = join(binDir, "invoked.log");
			writeFileSync(join(binDir, "codex"), `#!/bin/sh\necho $$ >> "${invokeLog}"\nexec sleep 30\n`);
			chmodSync(join(binDir, "codex"), 0o755);
			const prevPath = process.env.PATH ?? "";
			process.env.PATH = `${binDir}:${prevPath}`;
			testSetHandlerBudgetMs(300); // > spawn+log time, << the 5s assert / 25s guard
			try {
				const { pi, handlers } = makePi();
				codexReflector(pi);
				const handler = handlers.get(route.handler);
				expect(handler).toBeDefined();
				const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
					NonNullable<typeof handler>
				>[1];
				const start = Date.now();
				const result = await handler?.(
					route.event as unknown as Parameters<NonNullable<typeof handler>>[0],
					ctx,
				);
				const elapsed = Date.now() - start;
				expect(result).toBeUndefined(); // fail-open on every route
				expect(elapsed).toBeLessThan(5_000); // deadline fired, not the 25s guard
				expect(existsSync(invokeLog)).toBe(true); // route actually reached invokeCodex
				// The deadline must SIGKILL the spawned child, not just resolve — else a broken
				// abort path leaks a sleep-30 child. Poll each logged PID (resolve precedes close).
				for (const line of readFileSync(invokeLog, "utf8").split("\n")) {
					const pid = Number.parseInt(line.trim(), 10);
					if (Number.isInteger(pid)) expect(await waitForPidGone(pid, 4_000)).toBe(true);
				}
			} finally {
				process.env.PATH = prevPath;
				testSetHandlerBudgetMs(HANDLER_BUDGET_MS);
				rmSync(binDir, { recursive: true, force: true });
			}
		}, 15_000);
	}

	// Each builder route threads `signal` into its OWN matryoshkaCompact(..., signal) call
	// (see the builder functions in codex-reflector.ts), separate from the final invokeCodex
	// that HANGING_ROUTES covers. With tiny inputs those compaction calls return early (text <=
	// maxChars) and never spawn codex, so the tiny table cannot catch a dropped signal there.
	// Feed each route an input ABOVE its builder's matryoshkaCompact maxChars threshold so the
	// builder's own compaction call spawns codex and the deadline must SIGKILL it — mirroring
	// the 420K compactSnippet test for the remaining builder routes. Sizes account for the 8000
	// per-part / per-message cap in textOf/renderTranscript (thinking reads input.thought raw).
	const HANGING_COMPACTION_ROUTES: ReadonlyArray<{ label: string; handler: string; event: Record<string, unknown> }> = [
		{
			label: "tool_result/thinking (thought > 100k compaction threshold)",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "mcp__sequentialthinking", toolCallId: "id", input: { thought: "a".repeat(110_000) }, content: [], isError: false },
		},
		{
			label: "tool_result/bash_failure (error > 20k compaction threshold)",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "bash", toolCallId: "id", input: { command: "ls" }, content: Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(8000) })), isError: true },
		},
		{
			label: "tool_result/bash_success (output > 20k compaction threshold)",
			handler: "tool_result",
			event: { type: "tool_result", toolName: "bash", toolCallId: "id", input: { command: "ls" }, content: Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(8000) })), isError: false },
		},
		{
			label: "session_stop (transcript > 400k compaction threshold)",
			handler: "session_stop",
			event: { type: "session_stop", messages: Array.from({ length: 55 }, () => ({ role: "user", content: "a".repeat(8000) })), turn_id: 1, session_id: "s", stop_hook_active: false },
		},
		{
			label: "session_before_compact (transcript > 400k compaction threshold)",
			handler: "session_before_compact",
			event: { type: "session_before_compact", preparation: { messagesToSummarize: Array.from({ length: 55 }, () => ({ role: "user", content: "a".repeat(8000) })) } },
		},
	];
	for (const route of HANGING_COMPACTION_ROUTES) {
		test(`route ${route.label} fails open when the builder's matryoshka codex call hangs`, async () => {
			const binDir = mkdtempSync(join(tmpdir(), "codex-ref-fakebin-"));
			const invokeLog = join(binDir, "invoked.log");
			writeFileSync(join(binDir, "codex"), `#!/bin/sh\necho $$ >> "${invokeLog}"\nexec sleep 30\n`);
			chmodSync(join(binDir, "codex"), 0o755);
			const prevPath = process.env.PATH ?? "";
			process.env.PATH = `${binDir}:${prevPath}`;
			testSetHandlerBudgetMs(300); // > redact+spawn of the large input, << the 5s assert / 25s guard
			try {
				const { pi, handlers } = makePi();
				codexReflector(pi);
				const handler = handlers.get(route.handler);
				expect(handler).toBeDefined();
				const ctx = { cwd: ".", hasUI: false, ui: { notify() {} } } as unknown as Parameters<
					NonNullable<typeof handler>
				>[1];
				const start = Date.now();
				const result = await handler?.(
					route.event as unknown as Parameters<NonNullable<typeof handler>>[0],
					ctx,
				);
				const elapsed = Date.now() - start;
				expect(result).toBeUndefined(); // fail-open on the indirect compaction path
				expect(elapsed).toBeLessThan(5_000); // deadline fired, not the 25s guard
				expect(existsSync(invokeLog)).toBe(true); // the builder's matryoshkaCompact actually spawned codex
				// The deadline must SIGKILL each spawned child (matryoshka's, plus the final
				// invoke if it spawned), not merely resolve. Poll each logged PID.
				for (const line of readFileSync(invokeLog, "utf8").split("\n")) {
					const pid = Number.parseInt(line.trim(), 10);
					if (Number.isInteger(pid)) expect(await waitForPidGone(pid, 4_000)).toBe(true);
				}
			} finally {
				process.env.PATH = prevPath;
				testSetHandlerBudgetMs(HANDLER_BUDGET_MS);
				rmSync(binDir, { recursive: true, force: true });
			}
		}, 15_000);
	}
});

describe("handlerDeadline", () => {
	test("aborts after the budget elapses", async () => {
		const d = handlerDeadline(undefined, 10);
		expect(d.signal.aborted).toBe(false);
		await new Promise<void>((r) =>
			d.signal.addEventListener("abort", () => r(), { once: true }),
		);
		expect(d.signal.aborted).toBe(true);
		d.clear();
	});

	test("clear() cancels the pending abort", async () => {
		const d = handlerDeadline(undefined, 10);
		d.clear();
		await Bun.sleep(50);
		expect(d.signal.aborted).toBe(false);
	});

	test("aborts immediately when upstream is already aborted", () => {
		const d = handlerDeadline(AbortSignal.abort(), 10_000);
		expect(d.signal.aborted).toBe(true);
		d.clear();
	});

	test("propagates a later upstream abort", () => {
		const ac = new AbortController();
		const d = handlerDeadline(ac.signal, 10_000);
		expect(d.signal.aborted).toBe(false);
		ac.abort();
		expect(d.signal.aborted).toBe(true);
		d.clear();
	});

	test("clear() removes the upstream listener (no late abort, no leak)", () => {
		const ac = new AbortController();
		const d = handlerDeadline(ac.signal, 10_000);
		d.clear();
		ac.abort(); // fires AFTER clear — must not reach the deadline's controller
		expect(d.signal.aborted).toBe(false);
	});
});

describe("renderTranscript", () => {
	test("renders role-tagged blocks in order, skipping empty bodies", () => {
		const msgs = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "  " },
			{ role: "assistant", content: "hi there" },
		];
		expect(renderTranscript(msgs)).toBe("[user] hello\n\n[assistant] hi there");
	});

	test("tail-caps to the most recent 500K chars (PERF2)", () => {
		const msgs = Array.from({ length: 200 }, (_, i) => ({
			role: "user",
			content: `M${i}-${"x".repeat(8000)}`,
		}));
		const out = renderTranscript(msgs);
		expect(out.length).toBeLessThanOrEqual(500_000);
		expect(out.includes("M199-")).toBe(true); // newest kept
		expect(out.includes("M0-")).toBe(false); // oldest dropped
	});
});

describe("resolveChangeTarget", () => {
	function evt(toolName: string, input: Record<string, unknown>, details?: unknown): ToolResultEvent {
		return {
			type: "tool_result",
			toolName,
			toolCallId: "id",
			input,
			content: [],
			details,
		} as unknown as ToolResultEvent;
	}

	test("write -> input.path + input.content", () => {
		const r = resolveChangeTarget(evt("write", { path: "a.ts", content: "body" }));
		expect(r.filePath).toBe("a.ts");
		expect(r.rawSnippet).toBe("body");
	});

	test("edit prefers EditToolDetails.path + diff over input (CQ1)", () => {
		const r = resolveChangeTarget(
			evt("edit", { input: "[other.ts#AAAA]\n..." }, { path: "real.ts", diff: "@@ -1 +1 @@" }),
		);
		expect(r.filePath).toBe("real.ts"); // details.path, not the hashline header
		expect(r.rawSnippet).toBe("@@ -1 +1 @@"); // details.diff
	});

	test("edit falls back to the hashline header when details absent", () => {
		const r = resolveChangeTarget(evt("edit", { input: "[fallback.ts#BBBB]\nbody" }, undefined));
		expect(r.filePath).toBe("fallback.ts");
	});
	test("ast_edit -> per-path filePaths for multi-file edits (BE-R2)", () => {
		const r = resolveChangeTarget(evt("ast_edit", { paths: ["a.ts", "b.ts"] }));
		expect(r.filePath).toBe("a.ts, b.ts"); // joined display key
		expect(r.filePaths).toEqual(["a.ts", "b.ts"]); // per-path state keys
	});

	test("MCP Fast-Apply success snippet includes code_edit/instruction payload (CQ-R1)", () => {
		const r = resolveChangeTarget(
			evt("mcp__morph__edit_file", { path: "m.ts", code_edit: "EDIT-SKETCH", instruction: "DO-X" }),
		);
		expect(r.filePath).toBe("m.ts");
		expect(r.rawSnippet).toContain("DO-X"); // instruction
		expect(r.rawSnippet).toContain("EDIT-SKETCH"); // code_edit sketch
	});

	test("ast_edit dedups repeated paths (avoids self-superseding generations)", () => {
		const r = resolveChangeTarget(evt("ast_edit", { paths: ["a.ts", "a.ts", "b.ts"] }));
		expect(r.filePaths).toEqual(["a.ts", "b.ts"]);
	});
});

describe("notifyUI", () => {
	test("never throws and respects hasUI", () => {
		const throwing = {
			hasUI: true,
			ui: {
				notify() {
					throw new Error("no UI");
				},
			},
		};
		expect(() => notifyUI(throwing, "x", "info")).not.toThrow();
		let called = false;
		const headless = {
			hasUI: false,
			ui: {
				notify() {
					called = true;
				},
			},
		};
		notifyUI(headless, "x", "info");
		expect(called).toBe(false);
	});
});

describe("codeReviewResponse", () => {
	test("returns the opinion text for PASS", () => {
		const last = codeReviewResponse("PASS", "a.ts", "looks correct", []).content?.at(-1) as {
			type: string;
			text: string;
		};
		expect(last.type).toBe("text");
		expect(last.text).toContain("PASS");
		expect(last.text).toContain("looks correct");
	});
	test("FAIL stays advisory (no isError — per-tool reviews never block)", () => {
		const r = codeReviewResponse("FAIL", "a.ts", "missing guard", []);
		expect(r.isError).toBeFalsy();
		const last = r.content?.at(-1) as { type: string; text: string };
		expect(last.text).toContain("FAIL");
		expect(last.text).toContain("missing guard");
	});
	test("PASS and UNCERTAIN stay advisory (no isError — fail-open)", () => {
		expect(codeReviewResponse("PASS", "a.ts", "ok", []).isError).toBeFalsy();
		expect(codeReviewResponse("UNCERTAIN", "a.ts", "unsure", []).isError).toBeFalsy();
	});
});

describe("stopReviewDecision", () => {
	test("PASS settles (returns undefined, no block)", () => {
		expect(stopReviewDecision("PASS", "looks good")).toBeUndefined();
	});
	test("FAIL blocks with the review as reason", () => {
		const r = stopReviewDecision("FAIL", "missing guard");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("FAIL");
		expect(r?.reason).toContain("missing guard");
	});
	test("UNCERTAIN settles (returns undefined — never block on uncertainty)", () => {
		expect(stopReviewDecision("UNCERTAIN", "unsure")).toBeUndefined();
	});
});
