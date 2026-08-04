"""Typed shapes for every node's output, plus JSON Schema fragments for prompting."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


# --- Node output schemas, embedded verbatim into prompts ---------------------

DECOMPOSER_SCHEMA = {
    "domain": "one of: science | health | politics | history | economics | technology | other",
    "claim_type": "one of: factual | causal | statistical | predictive | normative",
    "sub_claims": [
        {
            "id": "S1",
            "text": "a single specific verifiable assertion",
            "why_it_matters": "why resolving this changes the verdict",
        }
    ],
    "ambiguities": ["terms in the claim that are undefined or contested"],
}

ADVOCATE_SCHEMA = {
    "confidence": "integer 0-100",
    "headline": "one sentence stating your position",
    "evidence": [
        {
            "point": "the evidentiary claim",
            "source": "study, institution, dataset, or report name — be specific",
            "strength": "one of: strong | moderate | weak",
        }
    ],
    "fallacies": ["logical or methodological flaws in the opposing position"],
    "concessions": ["points you must honestly concede to the other side"],
}

EXPERT_SCHEMA = {
    "certainty": "integer 0-100 — how settled this question is among experts",
    "consensus": "what the mainstream expert position actually is",
    "key_findings": [
        {"finding": "...", "source": "...", "year": "YYYY or 'unknown'"}
    ],
    "open_questions": ["what remains genuinely unresolved"],
    "common_misreadings": ["how this evidence is typically distorted in public debate"],
}

JUDGE_SCHEMA = {
    "verdict": "one of: TRUE | MOSTLY TRUE | MIXED | MOSTLY FALSE | FALSE",
    "truth_score": "integer 0-100",
    "confidence": "one of: High | Moderate | Low",
    "reasoning": "3-6 sentences explaining how you weighed the arguments",
    "strongest_for": "the single best argument the claim has going for it",
    "strongest_against": "the single best argument against it",
    "nuances": ["specific caveats a careful reader must hold"],
    "recommended_reading": ["specific papers, reports, or authors"],
}


# --- Runtime records --------------------------------------------------------


@dataclass
class NodeResult:
    """One node's execution record: what ran, what came back, what it cost."""

    role: str
    model: str
    provider: str
    data: dict[str, Any] | None = None
    error: str | None = None
    latency_s: float = 0.0
    repairs: int = 0
    raw: str = ""

    @property
    def ok(self) -> bool:
        return self.data is not None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("raw", None)
        d["ok"] = self.ok
        return d


@dataclass
class Trial:
    """The full docket for one claim."""

    claim: str
    nodes: list[NodeResult] = field(default_factory=list)
    verdict: dict[str, Any] | None = None
    total_s: float = 0.0

    def node(self, role: str) -> NodeResult | None:
        return next((n for n in self.nodes if n.role == role), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "claim": self.claim,
            "verdict": self.verdict,
            "total_s": round(self.total_s, 2),
            "nodes": [n.to_dict() for n in self.nodes],
        }
