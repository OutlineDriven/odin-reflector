# Concepts

Project-specific vocabulary for codex-reflector. One definition per term. Implementation paths live in code and AGENTS.md, not here.

## Review surfaces

### Claude/Cursor surface
The Python plugin that receives Claude Code (and Cursor-adapted) hook events, invokes Codex as a second model, and blocks Stop via exit code 2.

### OMP surface
The native oh-my-pi extension that registers the same review idea as hook handlers. Per-tool reviews are advisory; only the holistic Stop handler may block.

## Model routing

### Model tier
One of three reviewer roles the reflector assigns before calling Codex: default (everyday), frontier (risk-escalated, Stop, and precompact), and fast (tiny, mid-size gate, summarize). Slugs change when OpenAI renames the lineup; the three roles do not.

### Effort ladder
The closed set of reasoning efforts the reflector may send: low, medium, high, xhigh. Catalog values outside that set (including max and ultra) are intentionally unused.

### Model override
The `CODEX_REFLECTOR_MODEL` environment variable. When set, it replaces only the model slug on the Codex argv; the effort chosen by the route and gate is left unchanged.

### Model/effort gate
The heuristic that may upgrade a code-change review from the base preset to a harder or faster tier based on path risk and change size. Non-code-change categories keep their preset.

### Holistic Stop review
The single blocking review run once per stop chain. It uses the frontier tier at medium effort. A FAIL blocks; PASS and UNCERTAIN settle fail-open. Re-stops with the harness stop-active flag settle without re-reviewing.

## Flagged ambiguities

- "'Default model' is not 'frontier model'" — everyday presets stay on the default tier; risk-escalated reviews, Stop, and precompact use frontier.
- "'Model override' is not an effort override" — the env var never rewrites `model_reasoning_effort`.
