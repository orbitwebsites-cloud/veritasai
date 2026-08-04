# VeritasAI — web app

Next.js 15 (App Router) + Tailwind v4 + TypeScript. The full seven-stage
adversarial pipeline runs server-side in route handlers, so **API keys never
reach the browser**.

```bash
npm install
cp .env.example .env.local     # add CEREBRAS_API_KEY and/or GROQ_API_KEY
npm run dev                    # http://localhost:3000
```

```bash
npm test          # 77 offline tests, no API key or network needed
npm run build     # production build
```

## Deploying to Vercel

Zero config — no `vercel.json` needed. Function duration is declared per route
via `export const maxDuration = 300`.

```bash
cd web
vercel                                        # link + preview deploy
vercel env add CEREBRAS_API_KEY production    # paste key when prompted
vercel env add GROQ_API_KEY production
vercel --prod                                 # public URL
```

Set the same two variables for the `preview` and `development` environments if
you want preview deploys to work. They are read only on the server — there is
deliberately no `NEXT_PUBLIC_` prefix anywhere in this project.

> **Quota note.** With server-side keys, every visitor runs trials on *your*
> free-tier quota. Fine for a judged demo; it will rate-limit under real load.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | The courtroom UI |
| `GET /api/roster` | Live role → model assignments |
| `GET /api/trial?claim=…` | SSE stream: `progress` events, then `verdict` |
| `GET /api/verdict?claim=…` | Same trial, plain JSON (CORS open, no credentials returned) |

`/api/verdict` accepts `&ground=0` and `&citations=0` to skip retrieval or the
citation audit.

## Architecture

```
lib/
  config.ts      provider registry, roster, live catalog validation, failover lists
  prompts.ts     the five courtroom personas — the actual product
  engine.ts      orchestration, parallel stages, normalization
  grounding.ts   pre-trial retrieval (CrossRef + Wikipedia + DuckDuckGo)
  citations.ts   post-trial CrossRef verification of every cited source
  jsonio.ts      JSON extraction, salvage, repair
  providers.ts   OpenAI-wire-format chat with retry/backoff
components/      Bench, Verdict, Briefs, CitationAudit, Evidence, Courtroom
app/api/         roster · trial (SSE) · verdict (JSON)
tests/run.ts     offline suite
```

Everything that can overlap does: retrieval runs alongside decomposition, the
three briefs run concurrently, and the citation audit runs alongside the ruling.
A trial takes **~8–17s** depending on provider congestion.

## Reliability

Free tiers answer concurrent bursts with `429 high traffic`, and this pipeline
fires three requests at once by design. Two mechanisms handle it:

1. **Retry with backoff** (2 attempts, honours `Retry-After`).
2. **Cross-provider failover** — if a model's provider fails, the role moves to
   the next candidate, preferring a different provider. Retrying a host that
   just said "high traffic" mostly wastes time; switching works.

Measured: before failover, one trial in three lost the Defense to a 429. After,
**30/30 nodes across 5 consecutive trials**, and worst-case latency dropped from
45s to ~17s.

A dead node still doesn't kill the trial — the Judge is told which parties
failed to appear and lowers its confidence.

## Relationship to the Python version

The repo root holds the original Python implementation (CLI + stdlib web server
+ browser extension, 122 offline tests). This directory is a TypeScript port of
the same pipeline, built to deploy on Vercel. The prompts are identical; the
JSON salvage, grounding, and citation logic are ported behaviour-for-behaviour.

One deliberate difference: Python's `difflib.SequenceMatcher` has no JS
equivalent, so title similarity uses an LCS-based ratio. It scores slightly
higher on partial overlaps, so the citation thresholds were re-tuned against the
same benchmark rather than copied across.
