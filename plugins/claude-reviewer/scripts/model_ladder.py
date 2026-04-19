"""Model ladder helpers for claude-reviewer.

Maps short tier names (haiku, sonnet, opus) to Claude model IDs and provides
ordered escalation logic.
"""

from __future__ import annotations

MODEL_MAP: dict[str, str] = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-7",
}

_DEFAULT_LADDER = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]


def resolve_ladder(env_val: str) -> list[str]:
    """Parse CLAUDE_REVIEWER_ESCALATION into ordered model IDs.

    env_val is a comma-separated list of tier names, e.g. "haiku,sonnet,opus".
    Unknown tier names are passed through verbatim (allows custom model IDs).
    Returns the default ladder if env_val is empty or all entries are blank.
    """
    if not env_val or not env_val.strip():
        return list(_DEFAULT_LADDER)
    tiers = [t.strip() for t in env_val.split(",") if t.strip()]
    if not tiers:
        return list(_DEFAULT_LADDER)
    return [MODEL_MAP.get(t, t) for t in tiers]


def escalate(current: str, ladder: list[str]) -> str | None:
    """Return next model up the ladder, or None if already at top."""
    try:
        idx = ladder.index(current)
    except ValueError:
        return None
    next_idx = idx + 1
    if next_idx >= len(ladder):
        return None
    return ladder[next_idx]
