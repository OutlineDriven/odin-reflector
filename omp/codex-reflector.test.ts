import { describe, expect, test } from "bun:test";

import type { HookAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

import codexReflector, {
	changeSizeHeuristics,
	classify,
	type FailEntry,
	FailTracker,
	fileHeuristics,
	formatFails,
	gateModelEffort,
	parseVerdict,
	redact,
	renderTranscript,
	resolveChangeTarget,
	sandboxContent,
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

describe("formatFails", () => {
	test("renders `- tool [file]: feedback` lines", () => {
		const fails = new Map<string, FailEntry>([
			["a.ts", { tool: "write", file: "a.ts", feedback: "missing guard" }],
			["b.ts", { tool: "edit", file: "b.ts", feedback: "bad name" }],
		]);
		expect(formatFails(fails)).toBe("- write [a.ts]: missing guard\n- edit [b.ts]: bad name");
	});
	test("empty map -> empty string", () => {
		expect(formatFails(new Map())).toBe("");
	});
	test("caps at 5 entries", () => {
		const fails = new Map<string, FailEntry>();
		for (let i = 0; i < 8; i++) {
			fails.set(`f${i}.ts`, { tool: "write", file: `f${i}.ts`, feedback: "x" });
		}
		expect(formatFails(fails).split("\n")).toHaveLength(5);
	});
	test("truncates feedback to 300 chars", () => {
		const fails = new Map<string, FailEntry>([
			["a.ts", { tool: "write", file: "a.ts", feedback: "y".repeat(500) }],
		]);
		expect(formatFails(fails)).toBe(`- write [a.ts]: ${"y".repeat(300)}`);
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
	function makePi(): { pi: HookAPI; events: string[] } {
		const events: string[] = [];
		const stub = {
			on: (name: string) => {
				events.push(name);
			},
			sendMessage: () => {},
			appendEntry: () => {},
			logger: { debug() {}, info() {} },
		};
		// Test boundary: the stub only needs the surface the factory touches at registration.
		return { pi: stub as unknown as HookAPI, events };
	}

	test("registers the four lifecycle handlers", () => {
		const { pi, events } = makePi();
		codexReflector(pi);
		expect(new Set(events)).toEqual(
			new Set(["session_start", "tool_result", "agent_end", "session_before_compact"]),
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
});

describe("FailTracker", () => {
	test("record then clear toggles membership", () => {
		const t = new FailTracker();
		t.record("a.ts", "edit", "bad");
		expect(t.size).toBe(1);
		expect(t.clear("a.ts")).toBe(true);
		expect(t.size).toBe(0);
		expect(t.clear("a.ts")).toBe(false);
	});

	test("a no-op clear does NOT reset the re-engage guard (BE1)", () => {
		const t = new FailTracker();
		expect(t.tryReengage(3)).toBe(true); // 1
		expect(t.tryReengage(3)).toBe(true); // 2
		expect(t.clear("never.ts")).toBe(false); // file absent -> no reset
		expect(t.tryReengage(3)).toBe(true); // 3 -> cap
		expect(t.tryReengage(3)).toBe(false); // still capped; guard was not re-armed
	});

	test("clearing the last tracked FAIL resets the guard (observable progress)", () => {
		const t = new FailTracker();
		t.record("a.ts", "edit", "bad");
		expect(t.tryReengage(3)).toBe(true);
		expect(t.tryReengage(3)).toBe(true);
		expect(t.clear("a.ts")).toBe(true); // last FAIL gone -> reset
		expect(t.tryReengage(3)).toBe(true);
		expect(t.tryReengage(3)).toBe(true);
		expect(t.tryReengage(3)).toBe(true);
		expect(t.tryReengage(3)).toBe(false);
	});

	test("generation guard marks a superseded review stale (BE3)", () => {
		const t = new FailTracker();
		const gen1 = t.begin("a.ts");
		const gen2 = t.begin("a.ts"); // newer review opens before the first finishes
		expect(t.isCurrent("a.ts", gen1)).toBe(false);
		expect(t.isCurrent("a.ts", gen2)).toBe(true);
	});

	test("tryReengage is bounded by cap and resettable", () => {
		const t = new FailTracker();
		expect(t.tryReengage(2)).toBe(true);
		expect(t.tryReengage(2)).toBe(true);
		expect(t.tryReengage(2)).toBe(false);
		t.resetReengage();
		expect(t.tryReengage(2)).toBe(true);
	});

	test("replay rebuilds from a fresh map, dropping stale prior state (BE5)", () => {
		const t = new FailTracker();
		t.record("stale.ts", "edit", "leftover");
		t.replay([
			{ op: "set", file: "a.ts", tool: "write", feedback: "bad" },
			{ op: "set", file: "b.ts", tool: "edit", feedback: "worse" },
			{ op: "clear", file: "a.ts" },
		]);
		expect([...t.entries().keys()]).toEqual(["b.ts"]);
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
