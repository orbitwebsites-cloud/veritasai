"""Provider registry and role -> model resolution.

VeritasAI's whole premise is that different models argue differently. The roster
below assigns each courtroom role to a *different model family* so the
Prosecution and the Defense are not the same mind wearing two hats.

Everything is OpenAI-wire-compatible except Anthropic, which gets its own
adapter in providers.py. Cerebras hosts several open-weight families behind one
key, which is how the free tier still buys real model diversity.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


# --- Roles ------------------------------------------------------------------

DECOMPOSER = "decomposer"
PROSECUTION = "prosecution"
EXPERT = "expert"
DEFENSE = "defense"
JUDGE = "judge"

ROLES = [DECOMPOSER, PROSECUTION, EXPERT, DEFENSE, JUDGE]

# Support stages. Not model roles from the roster — grounding picks its own
# agentic search model, and citation checking calls CrossRef, not an LLM — but
# both report progress alongside the five nodes.
GROUNDING = "grounding"
CITATIONS = "citations"

ROLE_LABELS = {
    GROUNDING: "Court Researcher",
    DECOMPOSER: "Claim Decomposer",
    PROSECUTION: "The Prosecution",
    EXPERT: "Expert Witness",
    DEFENSE: "The Defense",
    JUDGE: "The Judge",
    CITATIONS: "Citation Clerk",
}

# Display order including support stages.
STAGES = [GROUNDING, DECOMPOSER, PROSECUTION, EXPERT, DEFENSE, JUDGE, CITATIONS]


# --- Providers --------------------------------------------------------------


@dataclass(frozen=True)
class Provider:
    name: str
    kind: str  # "openai" (wire format) or "anthropic"
    api_key_env: str
    base_url: str | None = None

    @property
    def api_key(self) -> str | None:
        key = os.getenv(self.api_key_env)
        return key.strip() if key and key.strip() else None

    @property
    def available(self) -> bool:
        return self.api_key is not None


PROVIDERS: dict[str, Provider] = {
    "cerebras": Provider("cerebras", "openai", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1"),
    "openai": Provider("openai", "openai", "OPENAI_API_KEY"),
    "anthropic": Provider("anthropic", "anthropic", "ANTHROPIC_API_KEY"),
    "groq": Provider("groq", "openai", "GROQ_API_KEY", "https://api.groq.com/openai/v1"),
    "together": Provider("together", "openai", "TOGETHER_API_KEY", "https://api.together.xyz/v1"),
}


# --- Roster -----------------------------------------------------------------
# Each role lists candidates in preference order. The first candidate whose
# provider has a key -- and whose model the provider actually serves -- wins.
# Deliberately spread across Llama / Qwen / GPT-OSS so the adversarial nodes
# genuinely disagree instead of echoing one pretraining distribution.

ROSTER: dict[str, list[tuple[str, str]]] = {
    # Clerical work. Smallest model that can hold a schema — it parses, it does
    # not judge, so capability here buys nothing but latency.
    DECOMPOSER: [
        ("groq", "llama-3.1-8b-instant"),
        ("cerebras", "gemma-4-31b"),
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-haiku-4-5-20251001"),
    ],
    # Llama family. Paired against a Gemma-family Defense on purpose.
    PROSECUTION: [
        ("groq", "llama-3.3-70b-versatile"),
        ("cerebras", "gpt-oss-120b"),
        ("anthropic", "claude-haiku-4-5-20251001"),
        ("openai", "gpt-4o-mini"),
    ],
    # GPT-OSS family — neither advocate's lineage, which is the point of a
    # court-appointed witness.
    EXPERT: [
        ("cerebras", "gpt-oss-120b"),
        ("groq", "openai/gpt-oss-120b"),
        ("openai", "gpt-4o"),
        ("anthropic", "claude-sonnet-4-5-20250929"),
    ],
    # Gemma family (Google lineage). Different pretraining distribution from
    # the Llama Prosecution, which is what makes the two briefs genuinely
    # independent rather than one model arguing with itself.
    DEFENSE: [
        ("cerebras", "gemma-4-31b"),
        ("groq", "qwen/qwen3.6-27b"),
        ("groq", "llama-3.3-70b-versatile"),
        ("openai", "gpt-4o-mini"),
    ],
    # The bench gets the strongest available model. GLM-4.7 is a reasoning
    # model, and synthesis across three conflicting briefs is the one place in
    # this pipeline where that actually pays for itself.
    JUDGE: [
        ("cerebras", "zai-glm-4.7"),
        ("cerebras", "gpt-oss-120b"),
        ("groq", "qwen/qwen3.6-27b"),
        ("anthropic", "claude-sonnet-4-5-20250929"),
        ("openai", "gpt-4o"),
    ],
}

# Models that stream chain-of-thought in <think> tags or need a reasoning knob.
REASONING_HINTS = ("qwen-3", "gpt-oss", "deepseek", "glm")


@dataclass(frozen=True)
class Assignment:
    role: str
    provider: Provider
    model: str

    @property
    def is_reasoning(self) -> bool:
        return any(h in self.model.lower() for h in REASONING_HINTS)


class NoProviderError(RuntimeError):
    pass


def available_providers() -> list[Provider]:
    return [p for p in PROVIDERS.values() if p.available]


# Non-chat models that show up in /v1/models listings and must never be picked
# as a fallback for a courtroom role.
_NOT_CHAT = ("embed", "whisper", "tts", "rerank", "guard", "moderation", "vision-encoder")


def _pick_fallback(live: list[Provider], catalog: dict[str, set[str]] | None) -> Assignment | None:
    """A last-resort model, used when a role's whole candidate list is dead.

    Prefers a known-good roster model; if the provider's model IDs have drifted
    away entirely, takes any plausible chat model it actually serves. Better a
    trial before an unfamiliar model than no trial at all.
    """
    for provider in live:
        served = catalog.get(provider.name) if catalog else None
        for candidates in ROSTER.values():
            for pname, model in candidates:
                if pname == provider.name and (served is None or model in served):
                    return Assignment("", provider, model)
        if served:
            usable = [m for m in sorted(served) if not any(bad in m.lower() for bad in _NOT_CHAT)]
            if usable:
                return Assignment("", provider, usable[0])
    return None


def resolve_roster(catalog: dict[str, set[str]] | None = None) -> dict[str, Assignment]:
    """Map every role to a concrete (provider, model) pair.

    ``catalog`` maps provider name -> the model IDs it actually serves, fetched
    live at startup. Model IDs drift; rather than hardcode and break, we verify
    against the live list and degrade to the next candidate. If nothing in a
    role's candidate list survives, we fall back to any working model from an
    available provider so the pipeline still runs end to end.
    """
    live = available_providers()
    if not live:
        names = ", ".join(p.api_key_env for p in PROVIDERS.values())
        raise NoProviderError(
            f"No API key found. Set one of: {names} in a .env file "
            f"(see .env.example). Cerebras has a free tier."
        )

    def serves(provider: Provider, model: str) -> bool:
        if catalog is None or provider.name not in catalog:
            return True  # unverifiable -> trust the roster
        return model in catalog[provider.name]

    fallback = _pick_fallback(live, catalog)

    resolved: dict[str, Assignment] = {}
    for role, candidates in ROSTER.items():
        pick = None
        for pname, model in candidates:
            provider = PROVIDERS[pname]
            if provider.available and serves(provider, model):
                pick = Assignment(role, provider, model)
                break
        if pick is None:
            if fallback is None:
                raise NoProviderError(
                    f"Provider(s) {[p.name for p in live]} served no usable model for role "
                    f"'{role}'. Run `python cli.py --models` to see the live catalog."
                )
            pick = Assignment(role, fallback.provider, fallback.model)
        resolved[role] = pick

    return resolved


# --- Tunables ---------------------------------------------------------------

MAX_TOKENS = int(os.getenv("VERITAS_MAX_TOKENS", "1600"))
JUDGE_MAX_TOKENS = int(os.getenv("VERITAS_JUDGE_MAX_TOKENS", "2200"))
TEMPERATURE = float(os.getenv("VERITAS_TEMPERATURE", "0.35"))
REQUEST_TIMEOUT = float(os.getenv("VERITAS_TIMEOUT", "90"))
MAX_REPAIRS = int(os.getenv("VERITAS_MAX_REPAIRS", "2"))
