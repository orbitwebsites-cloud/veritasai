"""The trial itself: decompose, hear three parties in parallel, then rule."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from . import citations, config as cfg, grounding, prompts
from .config import Assignment, CITATIONS, DECOMPOSER, DEFENSE, EXPERT, JUDGE, PROSECUTION
from .jsonio import JSONRecoveryError, as_list, coerce_int, extract_json, repair_prompt
from .providers import ProviderError, build_catalog, chat
from .schemas import (
    ADVOCATE_SCHEMA,
    DECOMPOSER_SCHEMA,
    EXPERT_SCHEMA,
    JUDGE_SCHEMA,
    NodeResult,
    Trial,
)

Progress = Callable[[str, str], Awaitable[None] | None]

VERDICT_LABELS = ("TRUE", "MOSTLY TRUE", "MIXED", "MOSTLY FALSE", "FALSE")
CONFIDENCE_LABELS = ("High", "Moderate", "Low")


async def _emit(cb: Progress | None, role: str, state: str) -> None:
    if cb is None:
        return
    result = cb(role, state)
    if asyncio.iscoroutine(result):
        await result


async def run_node(
    assignment: Assignment,
    system: str,
    user: str,
    schema: dict[str, Any],
    max_tokens: int,
    progress: Progress | None = None,
) -> NodeResult:
    """One call plus up to MAX_REPAIRS re-asks if the JSON comes back malformed.

    A node never raises. A dead node returns ``ok == False`` and the trial
    proceeds without it — the Judge is told which parties failed to appear and
    lowers its confidence accordingly.
    """
    result = NodeResult(role=assignment.role, model=assignment.model, provider=assignment.provider.name)
    started = time.perf_counter()
    await _emit(progress, assignment.role, "running")

    history: list[dict[str, str]] = [{"role": "user", "content": user}]
    last_error = "unknown"
    # Reasoning models spend a large share of their budget inside <think> before
    # writing a single character of JSON. Giving them the same budget as a
    # non-reasoning model is how you get a truncated thought and no payload.
    budget = int(max_tokens * 2.5) if assignment.is_reasoning else max_tokens

    for attempt in range(cfg.MAX_REPAIRS + 1):
        try:
            raw = await chat(assignment, system, history, budget)
        except ProviderError as exc:
            result.error = str(exc)
            result.latency_s = round(time.perf_counter() - started, 2)
            await _emit(progress, assignment.role, "failed")
            return result

        result.raw = raw
        try:
            result.data = extract_json(raw)
            result.repairs = attempt
            result.latency_s = round(time.perf_counter() - started, 2)
            await _emit(progress, assignment.role, "done")
            return result
        except JSONRecoveryError as exc:
            last_error = str(exc)
            if attempt == cfg.MAX_REPAIRS:
                break
            await _emit(progress, assignment.role, "repairing")
            # Keep the original task in view; append the bad turn and correct it.
            # An empty assistant turn is rejected by some providers, so a
            # truncated-to-nothing response gets a placeholder.
            history = [
                history[0],
                {"role": "assistant", "content": raw[:2000] or "[no output produced]"},
                {"role": "user", "content": repair_prompt(schema, last_error)},
            ]

    result.repairs = cfg.MAX_REPAIRS
    result.error = f"unparseable JSON after {cfg.MAX_REPAIRS} repair attempts ({last_error})"
    result.latency_s = round(time.perf_counter() - started, 2)
    await _emit(progress, assignment.role, "failed")
    return result


# --- Normalization ----------------------------------------------------------
# Open-weight models honor a schema loosely. Rather than reject a good argument
# over a wrong key name, we coerce each payload into the shape the UI expects.


def _norm_docket(data: dict[str, Any] | None, claim: str) -> dict[str, Any]:
    if not data:
        return {"domain": "other", "claim_type": "factual", "sub_claims": [{"id": "S1", "text": claim}], "ambiguities": []}
    subs = as_list(data.get("sub_claims") or data.get("subclaims") or data.get("claims"))
    normalized = []
    for i, s in enumerate(subs, 1):
        if isinstance(s, str):
            normalized.append({"id": f"S{i}", "text": s, "why_it_matters": ""})
        elif isinstance(s, dict):
            normalized.append(
                {
                    "id": str(s.get("id") or f"S{i}"),
                    "text": str(s.get("text") or s.get("claim") or s.get("sub_claim") or ""),
                    "why_it_matters": str(s.get("why_it_matters") or s.get("relevance") or ""),
                }
            )
    return {
        "domain": str(data.get("domain") or "other"),
        "claim_type": str(data.get("claim_type") or data.get("type") or "factual"),
        "sub_claims": [s for s in normalized if s["text"]] or [{"id": "S1", "text": claim, "why_it_matters": ""}],
        "ambiguities": [str(a) for a in as_list(data.get("ambiguities") or data.get("ambiguous_terms"))],
    }


def _norm_evidence(items: Any) -> list[dict[str, str]]:
    out = []
    for e in as_list(items):
        if isinstance(e, str):
            out.append({"point": e, "source": "unspecified", "strength": "weak"})
        elif isinstance(e, dict):
            strength = str(e.get("strength") or "moderate").lower()
            out.append(
                {
                    "point": str(e.get("point") or e.get("evidence") or e.get("claim") or ""),
                    "source": str(e.get("source") or e.get("citation") or "unspecified"),
                    "strength": strength if strength in ("strong", "moderate", "weak") else "moderate",
                }
            )
    return [e for e in out if e["point"]]


def _norm_advocate(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if not data:
        return None
    return {
        "confidence": coerce_int(data.get("confidence") or data.get("confidence_score")),
        "headline": str(data.get("headline") or data.get("position") or data.get("summary") or ""),
        "evidence": _norm_evidence(data.get("evidence") or data.get("arguments") or data.get("points")),
        "fallacies": [str(f) for f in as_list(data.get("fallacies") or data.get("logical_fallacies"))],
        "concessions": [str(c) for c in as_list(data.get("concessions") or data.get("concessions_to_other_side"))],
    }


def _norm_expert(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if not data:
        return None
    findings = []
    for f in as_list(data.get("key_findings") or data.get("findings")):
        if isinstance(f, str):
            findings.append({"finding": f, "source": "unspecified", "year": "unknown"})
        elif isinstance(f, dict):
            findings.append(
                {
                    "finding": str(f.get("finding") or f.get("point") or ""),
                    "source": str(f.get("source") or "unspecified"),
                    "year": str(f.get("year") or "unknown"),
                }
            )
    return {
        "certainty": coerce_int(data.get("certainty") or data.get("confidence")),
        "consensus": str(data.get("consensus") or data.get("expert_consensus") or ""),
        "key_findings": [f for f in findings if f["finding"]],
        "open_questions": [str(q) for q in as_list(data.get("open_questions"))],
        "common_misreadings": [str(m) for m in as_list(data.get("common_misreadings") or data.get("misconceptions"))],
    }


def _norm_verdict(data: dict[str, Any] | None, pro_conf: int, def_conf: int) -> dict[str, Any]:
    """Coerce the ruling, and reconcile the label with the score if they conflict."""
    if not data:
        # No ruling: fall back to the advocates' own numbers so the user still
        # gets a calibrated answer instead of an error page.
        score = max(0, min(100, (def_conf + (100 - pro_conf)) // 2))
        data = {
            "verdict": _label_for(score),
            "truth_score": score,
            "confidence": "Low",
            "reasoning": "The Judge failed to return a ruling. This score is derived "
            "from the Prosecution and Defense confidence scores alone and should be "
            "treated as provisional.",
        }

    score = coerce_int(data.get("truth_score") or data.get("score"))
    label = str(data.get("verdict") or data.get("label") or "").strip().upper()
    if label not in VERDICT_LABELS:
        label = _label_for(score)
    elif _label_for(score) != label:
        # Model picked a label its own score contradicts. The prose label is the
        # more considered judgment, so snap the score into that band.
        score = _score_for(label, score)

    conf = str(data.get("confidence") or "Moderate").strip().title()
    if conf not in CONFIDENCE_LABELS:
        conf = "Moderate"

    return {
        "verdict": label,
        "truth_score": score,
        "confidence": conf,
        "reasoning": str(data.get("reasoning") or data.get("explanation") or ""),
        "strongest_for": str(data.get("strongest_for") or data.get("strongest_argument_for") or ""),
        "strongest_against": str(data.get("strongest_against") or data.get("strongest_argument_against") or ""),
        "nuances": [str(n) for n in as_list(data.get("nuances") or data.get("caveats"))],
        "recommended_reading": [str(r) for r in as_list(data.get("recommended_reading") or data.get("further_reading"))],
    }


_BANDS = ((15, "FALSE"), (39, "MOSTLY FALSE"), (60, "MIXED"), (84, "MOSTLY TRUE"), (100, "TRUE"))


def _label_for(score: int) -> str:
    return next(label for ceiling, label in _BANDS if score <= ceiling)


def _score_for(label: str, current: int) -> int:
    ranges = {"FALSE": (0, 15), "MOSTLY FALSE": (16, 39), "MIXED": (40, 60), "MOSTLY TRUE": (61, 84), "TRUE": (85, 100)}
    lo, hi = ranges[label]
    return max(lo, min(hi, current))


# --- Orchestration ----------------------------------------------------------


async def resolve() -> dict[str, Assignment]:
    """Verify model IDs against the live catalog, then assign roles."""
    catalog = await build_catalog(cfg.available_providers())
    return cfg.resolve_roster(catalog or None)


async def try_claim(
    claim: str,
    roster: dict[str, Assignment] | None = None,
    progress: Progress | None = None,
    ground: bool = True,
    verify_citations: bool = True,
) -> Trial:
    """Run the full trial and return the docket.

    ``ground`` runs a live web search before the briefs so the parties argue
    from current evidence rather than training data. ``verify_citations``
    checks every cited source against CrossRef after the ruling. Both are
    best-effort: neither can fail the trial.
    """
    claim = claim.strip()
    if not claim:
        raise ValueError("claim is empty")

    roster = roster or await resolve()
    trial = Trial(claim=claim)
    started = time.perf_counter()

    # Node 0 and Node 1 both need only the claim, so the web search runs
    # concurrently with decomposition and is effectively free.
    async def _ground() -> NodeResult | None:
        if not ground:
            return None
        await _emit(progress, grounding.GROUNDING, "running")
        res = await grounding.ground(claim)
        await _emit(progress, grounding.GROUNDING, "done" if res.ok else "failed")
        return res

    clerk_task = run_node(
        roster[DECOMPOSER],
        prompts.DECOMPOSER_SYSTEM,
        prompts.decomposer_user(claim),
        DECOMPOSER_SCHEMA,
        cfg.MAX_TOKENS,
        progress,
    )
    search, clerk = await asyncio.gather(_ground(), clerk_task)

    if search is not None:
        trial.nodes.append(search)
    trial.nodes.append(clerk)
    docket = _norm_docket(clerk.data, claim)
    context = grounding.as_context(search)

    # Nodes 2-4 — three independent parties. Nothing about the Prosecution's
    # brief informs the Defense's, so running them serially would be pure
    # latency. This is where the ~3x speedup lives.
    pro_task = run_node(
        roster[PROSECUTION],
        prompts.PROSECUTION_SYSTEM,
        prompts.prosecution_user(claim, docket, context),
        ADVOCATE_SCHEMA,
        cfg.MAX_TOKENS,
        progress,
    )
    exp_task = run_node(
        roster[EXPERT],
        prompts.EXPERT_SYSTEM,
        prompts.expert_user(claim, docket, context),
        EXPERT_SCHEMA,
        cfg.MAX_TOKENS,
        progress,
    )
    def_task = run_node(
        roster[DEFENSE],
        prompts.DEFENSE_SYSTEM,
        prompts.defense_user(claim, docket, context),
        ADVOCATE_SCHEMA,
        cfg.MAX_TOKENS,
        progress,
    )
    pro, exp, dfn = await asyncio.gather(pro_task, exp_task, def_task)
    trial.nodes.extend([pro, exp, dfn])

    prosecution = _norm_advocate(pro.data)
    expert = _norm_expert(exp.data)
    defense = _norm_advocate(dfn.data)

    briefs = {
        "docket": docket,
        "prosecution": prosecution,
        "expert": expert,
        "defense": defense,
    }

    # Node 5 (the ruling) and citation verification are independent: the
    # verifier reads the filed briefs, not the verdict. Run them together.
    judge_task = run_node(
        roster[JUDGE],
        prompts.JUDGE_SYSTEM,
        prompts.judge_user(claim, docket, prosecution, expert, defense, context),
        JUDGE_SCHEMA,
        cfg.JUDGE_MAX_TOKENS,
        progress,
    )

    async def _verify() -> dict[str, Any] | None:
        if not verify_citations:
            return None
        await _emit(progress, CITATIONS, "running")
        try:
            report = await citations.verify_briefs(briefs)
        except Exception as exc:  # noqa: BLE001 - verification never fails a trial
            await _emit(progress, CITATIONS, "failed")
            return {"checks": [], "summary": {}, "flagged": 0, "checked": 0,
                    "error": f"{type(exc).__name__}: {exc}"}
        await _emit(progress, CITATIONS, "done")
        return report

    judge, citation_report = await asyncio.gather(judge_task, _verify())
    trial.nodes.append(judge)

    trial.verdict = _norm_verdict(
        judge.data,
        prosecution["confidence"] if prosecution else 50,
        defense["confidence"] if defense else 50,
    )
    trial.total_s = time.perf_counter() - started

    trial.verdict["_briefs"] = briefs
    trial.verdict["_grounding"] = (search.data | {"model": search.model}) if (search and search.ok) else None
    trial.verdict["_citations"] = citation_report
    return trial
