"""Async chat clients. One wire format per provider kind, cached per process."""

from __future__ import annotations

import asyncio
from functools import lru_cache
from typing import Any

from .config import Assignment, Provider, REQUEST_TIMEOUT, TEMPERATURE


class ProviderError(RuntimeError):
    pass


@lru_cache(maxsize=None)
def _openai_client(base_url: str | None, api_key: str):
    from openai import AsyncOpenAI

    return AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=REQUEST_TIMEOUT, max_retries=2)


@lru_cache(maxsize=None)
def _anthropic_client(api_key: str):
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=api_key, timeout=REQUEST_TIMEOUT, max_retries=2)


def _client(provider: Provider):
    key = provider.api_key
    if not key:
        raise ProviderError(f"{provider.name}: {provider.api_key_env} is not set")
    if provider.kind == "anthropic":
        return _anthropic_client(key)
    return _openai_client(provider.base_url, key)


async def chat(
    assignment: Assignment,
    system: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float = TEMPERATURE,
) -> str:
    """Send a system prompt + message history, return the raw text response."""
    provider = assignment.provider
    client = _client(provider)

    try:
        if provider.kind == "anthropic":
            resp = await client.messages.create(
                model=assignment.model,
                system=system,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")

        kwargs: dict[str, Any] = {
            "model": assignment.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "max_completion_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = await client.chat.completions.create(**kwargs)
        if not resp.choices:
            raise ProviderError(f"{assignment.model}: response contained no choices")
        return resp.choices[0].message.content or ""

    except ProviderError:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced to the node, never fatal
        raise ProviderError(f"{provider.name}/{assignment.model}: {type(exc).__name__}: {exc}") from exc


async def fetch_catalog(provider: Provider) -> set[str]:
    """Model IDs a provider actually serves. Empty set means 'could not verify'."""
    if provider.kind == "anthropic":
        return set()
    try:
        client = _client(provider)
        page = await client.models.list()
        return {m.id for m in page.data}
    except Exception:  # noqa: BLE001 - verification is best-effort by design
        return set()


async def build_catalog(providers: list[Provider]) -> dict[str, set[str]]:
    results = await asyncio.gather(*(fetch_catalog(p) for p in providers))
    return {p.name: ids for p, ids in zip(providers, results) if ids}
