# RECOVERY — VeritasAI

**State: complete, deployed, and verified working.** 2026-08-04

## Live deployment

**https://veritasai-xi.vercel.app** — Vercel project `orbitboyzz-4697s-projects/veritasai`

Verified live: 6/6 nodes, ~5-9s per trial, SSE streaming, citation audit firing.

Two things to know:
1. It deployed to **production**, not preview. A CLI-linked project with no
   connected Git repo promotes straight to production — `vercel deploy` reported
   `"target": "production"`. Preview-scoped env vars are impossible without a
   connected repo for the same reason.
2. **DuckDuckGo returns 0 results from Vercel's IPs** (datacenter blocking).
   CrossRef and Wikipedia work, so grounding still functions with 2 of 3
   sources — degradation is graceful and visible in the UI counts.

Redeploy: `cd web && vercel deploy --yes` (production env vars are already set).

## Two codebases

| Path | What it is |
|---|---|
| `C:\ha` (root) | Original Python implementation — CLI, stdlib web server, browser extension. 122 offline tests. |
| `C:\ha\web` | TypeScript port on Next.js 15 + Tailwind v4. The deployable. 77 offline tests. |

Prompts are identical between them. See `web/README.md` for the one deliberate
difference (similarity scoring, and why thresholds were re-tuned).

## What exists

7-stage adversarial fact-checking pipeline at `C:\ha` — CLI, web courtroom, and
browser extension — running live on Cerebras + Groq free tiers.

| File | Purpose |
|------|---------|
| `veritas/config.py` | Provider registry, role roster, live catalog validation |
| `veritas/prompts.py` | The five courtroom personas — the core of the project |
| `veritas/engine.py` | Orchestration, parallel stages, output normalization |
| `veritas/grounding.py` | Pre-trial retrieval: CrossRef + Wikipedia + DuckDuckGo |
| `veritas/citations.py` | Post-trial CrossRef verification of every cited source |
| `veritas/jsonio.py` | JSON extraction + salvage passes |
| `veritas/providers.py` | Async clients (OpenAI wire format + Anthropic) |
| `veritas/schemas.py` | Node output shapes |
| `cli.py` / `web.py` | Terminal and browser courtrooms |
| `extension/` | MV3 browser extension (manifest, background, content, popup) |
| `selftest.py` | 115 offline tests, no API key required |
| `README.md` / `DEVPOST.md` | Docs and corrected submission text |

## Verified working

- `python selftest.py` → **115 passed, 0 failed**, exit 0
- `python cli.py --quiet "..."` → all nodes ok, ~7s
- 5-claim live sweep → **0 failed nodes out of 25 calls**; Defense argued 5/5
  without refusing
- Web UI driven end-to-end in a real browser: all 7 stages streamed via SSE,
  verdict FALSE 5/100, citation audit flagged 3 of 9, grounding returned
  4 papers + 5 web results with live DOI links
- `GET /api/verdict?claim=...` → 6/6 nodes ok, 7.22s (the extension's endpoint)
- Citation precision on a fixed set: **0 false accusations / 5 real papers,
  3/3 fabrications caught** (incl. invented DOI), 0 vague prose accused

## Current roster (verified live)

```
Court Researcher   direct     crossref + wikipedia + duckduckgo
Claim Decomposer   groq       llama-3.1-8b-instant
The Prosecution    groq       llama-3.3-70b-versatile
Expert Witness     cerebras   gpt-oss-120b
The Defense        cerebras   gemma-4-31b
The Judge          cerebras   zai-glm-4.7
Citation Clerk     direct     crossref lookup
```

Model IDs are validated against each provider's live `/v1/models` at startup and
degrade automatically. Run `python cli.py --models` to see current assignments.

## Bugs found and fixed during the build

1. **Roster collapse** — every hardcoded model ID was wrong; all five roles
   silently fell back to one model. Fixed with live catalog validation.
2. **Repair loop destroyed context** — replaced conversation history instead of
   appending, so the Judge lost the briefs and reported "no arguments provided."
3. **Reasoning models starved** — GLM/GPT-OSS spend most of their budget inside
   `<think>`; they now get 2.5x tokens.
4. **Unquoted string values** — `llama-3.3-70b-versatile` emits
   `"headline": bare text,`. Added salvage; the first regex backtracked over
   whitespace and quoted numbers too, fixed by anchoring the value to `\S`.
5. **Truncated JSON discarded** — added `_close_truncated` salvage.
6. **Citation checker failed open** — CrossRef network errors were reported as
   "institutional, not checked", so a fabricated citation passed while the
   service was rate-limiting. Added an explicit `unchecked` status.
7. **Citation checker then over-accused** — surname-only matching flagged real
   papers (Madsen, Taylor) as fabricated and matched a vaccine study to a paper
   on learning Arabic. Rebuilt to require title corroboration, to separate
   misattribution from fabrication, and to show no match rather than a wrong one.
8. **`groq/compound` grounding unusable** — free-tier quota 413s on even a
   27-token request. Replaced LLM search with direct keyless retrieval.

All have regression tests in `selftest.py`.

## Open items (nothing blocking)

- Verification confirms a cited work **exists**, not that it says what the
  advocate claims. Needs abstract retrieval + entailment. Honest remaining gap.
- No multi-language support in the prompts yet.
- `.env` holds live keys and is gitignored. **Rotate before publishing the repo**
  — the keys were pasted into a chat transcript.

## Next step if resuming

Nothing is half-finished. Optional work, in value order:
1. Claim-level entailment checking of cited sources
2. Record a demo video (web UI at `python web.py --open` is the best surface)
3. Multi-language prompts
