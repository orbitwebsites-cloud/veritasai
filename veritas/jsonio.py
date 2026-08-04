"""Getting clean JSON out of models that insist on decorating it.

Three failure modes show up constantly across open-weight models:
  1. markdown fences  ```json ... ```
  2. reasoning models emitting <think>...</think> before the payload
  3. prose preamble ("Here is the analysis:") before the opening brace

We strip all three, then fall back to brace-matching, then to a repair round
trip against the model itself.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FENCE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_OPEN_THINK = re.compile(r"^.*?</think>", re.DOTALL | re.IGNORECASE)
_TRAILING_COMMA = re.compile(r",(\s*[}\]])")

# Llama-3.3-70b reliably emits string values without quotes when the value
# contains no commas, e.g.  "headline": The claim is false,
# The JSON is otherwise perfect, so throwing the whole brief away over it would
# be absurd. Match a key, then a value that starts like none of the legal JSON
# value openers, and quote it.
# The value pattern must start at a non-space character. Without that anchor
# the trailing [ \t]* backtracks, the lookahead lands on a space instead of the
# first real character, and legitimate numbers and arrays get quoted too.
_BARE_VALUE = re.compile(
    r'^(?P<pre>\s*"[^"\n]+"\s*:[ \t]*)'
    r'(?P<val>(?!["\[{\d\-]|true\b|false\b|null\b)\S[^\n]*?)'
    r"(?P<comma>,?)[ \t]*$",
    re.MULTILINE,
)


def _quote_bare_values(text: str) -> str:
    def fix(m: re.Match[str]) -> str:
        val = m.group("val").strip()
        if not val or val in ("{", "[", "}", "]"):
            return m.group(0)
        val = val.replace("\\", "\\\\").replace('"', '\\"')
        return f'{m.group("pre")}"{val}"{m.group("comma")}'

    return _BARE_VALUE.sub(fix, text)


def _close_truncated(text: str) -> str:
    """Close a response that ran out of tokens mid-object.

    A truncated brief still carries most of its evidence; recovering it beats
    spending another round trip to get the same content back.
    """
    depth_stack: list[str] = []
    in_str = False
    escaped = False
    for ch in text:
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            depth_stack.append(ch)
        elif ch in "}]" and depth_stack:
            depth_stack.pop()

    if not in_str and not depth_stack:
        return text

    out = text.rstrip()
    if in_str:
        out += '"'
    # Drop a dangling  "key":  or trailing comma that would break the close.
    out = re.sub(r',\s*$', "", out)
    out = re.sub(r'"[^"\n]*"\s*:\s*$', "", out).rstrip().rstrip(",")
    for opener in reversed(depth_stack):
        out += "}" if opener == "{" else "]"
    return out


class JSONRecoveryError(ValueError):
    pass


def _balanced_slice(text: str) -> str | None:
    """Return the first balanced {...} block, ignoring braces inside strings."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_json(raw: str) -> dict[str, Any]:
    """Best-effort parse of a model response into a dict. Raises on total failure."""
    if not raw or not raw.strip():
        raise JSONRecoveryError("empty response")

    text = _THINK.sub("", raw)
    # A truncated reasoning block leaves a dangling </think> with no opener.
    if "</think>" in text:
        text = _OPEN_THINK.sub("", text)
    text = text.strip()

    candidates: list[str] = []
    for match in _FENCE.findall(text):
        candidates.append(match.strip())
    candidates.append(text)
    block = _balanced_slice(text)
    if block:
        candidates.append(block)

    # Salvage passes, cheapest and least invasive first. Each is applied on top
    # of the previous one, so a response that is both truncated and missing
    # quotes still comes back.
    def variants(s: str):
        yield s
        s = _TRAILING_COMMA.sub(r"\1", s)
        yield s
        s = _quote_bare_values(s)
        yield s
        yield _close_truncated(s)

    for candidate in candidates:
        if not candidate:
            continue
        for attempt in variants(candidate):
            try:
                parsed = json.loads(attempt)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
                return parsed[0]

    raise JSONRecoveryError(f"no parseable JSON object in {len(raw)} chars of output")


def repair_prompt(schema: dict[str, Any], error: str) -> str:
    """A terse re-ask, appended to the live conversation.

    This is deliberately *not* a fresh prompt. An earlier version replaced the
    history with this text alone, and the Judge — having lost the briefs it was
    meant to rule on — dutifully reported that no arguments had been provided.
    The original task stays in the history; this only corrects the format.
    """
    return (
        "STOP. Your last response could not be parsed.\n"
        f"Parser error: {error}\n\n"
        "The task above is unchanged. Answer it again, but this time emit "
        "nothing except a single valid JSON object of this shape:\n"
        f"{json.dumps(schema, indent=2)}\n\n"
        "Begin your response with the character { and end it with the character }. "
        "Do not think out loud. Do not use markdown fences. Do not explain. "
        "If you were cut off last time, be brief — a short complete JSON object "
        "is far better than a long truncated one."
    )


def coerce_int(value: Any, default: int = 50, lo: int = 0, hi: int = 100) -> int:
    """Models return scores as 72, '72', '72/100', or 0.72. Normalize all of them."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        n = float(value)
        if 0 < n <= 1 and not float(n).is_integer():
            n *= 100
        return max(lo, min(hi, int(round(n))))
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        if match:
            return coerce_int(float(match.group()), default, lo, hi)
    return default


def as_list(value: Any) -> list[Any]:
    """Normalize a field the model may have returned as a bare string or None."""
    if value is None:
        return []
    if isinstance(value, list):
        return [v for v in value if v not in (None, "")]
    return [value]
