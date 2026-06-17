import { describe, expect, test } from "bun:test";

import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import codexReflector, {
	changeSizeHeuristics,
	classify,
	codeReviewResponse,
	fileHeuristics,
	gateModelEffort,
	notifyUI,
	parseVerdict,
	redact,
	renderTranscript,
	resolveChangeTarget,
	sandboxContent,
	stopReviewDecision,
} from "./codex-reflector.ts";

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
	test("bash failure -> bash_failure, bash success -> null", () => {
		expect(classify("bash", true)?.category).toBe("bash_failure");
		expect(classify("bash", false)).toBeNull();
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
	} {
		const events: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const stub = {
			on: (name: string, handler: unknown) => {
				events.push(name);
				if (typeof handler === "function") {
					handlers.set(name, handler as (event: unknown, ctx: unknown) => unknown);
				}
			},
			sendMessage: () => {},
			logger: { debug() {}, info() {} },
		};
		return { pi: stub as unknown as ExtensionAPI, events, handlers };
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
