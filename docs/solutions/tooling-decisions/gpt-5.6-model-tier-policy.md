---
title: GPT-5.6 model tier policy for codex-reflector
date: 2026-07-11
category: tooling-decisions
module: codex-reflector
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "OpenAI ships a new Codex model lineup and the reflector pins must move"
  - "Someone proposes max, ultra, or a spark-style effort clamp for reviews"
  - "Routing tests assert only effort and leave model names free"
tags:
  - model-routing
  - gpt-5.6
  - sol-terra-luna
  - effort-ladder
  - codex-reflector
---

# GPT-5.6 model tier policy for codex-reflector

## Context

The reflector pins three roles (`DEFAULT_MODEL`, `FRONTIER_MODEL`, `FAST_MODEL`) and a closed effort ladder. When OpenAI renamed the lineup to GPT-5.6, the easy mistakes were: pin everything to the frontier model, keep a spark-style effort clamp, or adopt catalog efforts (`max` / `ultra`) that look free but break the product.

## Guidance

Keep a three-role partition, not a single model:

| Role | Current slug | Owns |
|------|--------------|------|
| Default | `gpt-5.6-terra` | Everyday reviews, thinking, bash, precompact |
| Frontier | `gpt-5.6-sol` | Risk-escalated code review, plan review, holistic Stop |
| Fast | `gpt-5.6-luna` | Tiny reviews, mid-size gate, summarize |

Rules that must survive the next re-tier:

1. **Stop is frontier @ medium on both surfaces.** The holistic Stop gate is the only blocking path; it rides the frontier model. Do not put Stop on the default or fast tier to save cost.
2. **Effort ladder stays `low | medium | high | xhigh`.** Do not add `max` or `ultra`. `ultra` is task-delegation oriented (wrong for a read-only reviewer). `max` risks blowing the OMP handler budget and turning reviews into silent fail-open no-ops.
3. **No spark clamp.** Delete any model-specific "force effort up to high" branch. `CODEX_REFLECTOR_MODEL` may swap `-m` only; the route's effort passes through verbatim, even when the override is a legacy spark slug.
4. **Parity on both surfaces.** Python (`scripts/codex-reflector.py`) and OMP (`omp/codex-reflector.ts`) must share the same role assignment and effort table. Ship code + all paired manifests in the same commit (AGENTS.md).
5. **Tests hard-code the three-way partition.** `gateModelEffort` assertions use exact `(model, effort)` pairs. Argv-capture tests prove Stop uses frontier @ medium and that a model override preserves effort. Stop argv tests must clear ambient `CODEX_REFLECTOR_MODEL` or the override hides a correct preset.

## Why This Matters

A single-model re-pin wastes frontier spend on tiny edits and under-spends on Stop. A spark clamp lies about effort under env overrides. Catalog efforts that look "stronger" can drop the review entirely under the OMP 30s handler race. Soft tests that only check effort let a silent model drift ship.

## When to Apply

- Any Codex model lineup rename or tier re-pin
- Proposals to extend the effort union or reintroduce a model-specific effort clamp
- Adding or rewriting model-routing tests

## Examples

Before (legacy single-family pins plus spark clamp):

- Default and frontier collapsed to one slug; fast was a mini model.
- `LIGHTNING_FAST_MODEL` forced low/medium → high, so an env override could not keep a low-effort tiny review.

After (GPT-5.6 roles):

- Terra / sol / luna map 1:1 onto DEFAULT / FRONTIER / FAST.
- Override `CODEX_REFLECTOR_MODEL=gpt-5.3-codex-spark` on a tiny edit still emits `model_reasoning_effort=low`.

## Related

- AGENTS.md surface-split and same-commit version-bump rules
- `CONCEPTS.md` entries for Model tier, Effort ladder, and Model override
