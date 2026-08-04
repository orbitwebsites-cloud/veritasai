# VeritasAI

**Every claim deserves a trial.**

A fact-checker built as an adversarial courtroom. Instead of asking one model
what it thinks — which reliably produces "well, correlation isn't causation" —
VeritasAI forces five different models into five fixed roles, makes two of them
argue opposite sides as hard as they can, and puts a fifth on the bench to rule.

```bash
python cli.py "The Great Wall of China is visible from space"
```

```
  MOSTLY FALSE
  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  25/100
  judicial confidence: Moderate

  The Defense concedes that the Wall is not visible under average conditions,
  which undermines the general validity of the claim. The Expert Witness
  provides strong technical evidence, including specific resolution limits,
  establishing that the Wall's width is generally below the threshold of
  naked-eye visibility from Low Earth Orbit...
```

---

## The pipeline

| # | Stage | Model | Family | Job |
|---|-------|-------|--------|-----|
| 0 | Court Researcher | *no model* | — | Retrieve live evidence before anyone argues |
| 1 | Claim Decomposer | `llama-3.1-8b-instant` | Llama | Split the claim into checkable sub-claims |
| 2 | The Prosecution | `llama-3.3-70b-versatile` | Llama | Strongest case that it's **false** |
| 3 | Expert Witness | `gpt-oss-120b` | GPT-OSS | Neutral read on what the evidence says |
| 4 | The Defense | `gemma-4-31b` | Gemma | Strongest case that it's **true** |
| 5 | The Judge | `zai-glm-4.7` | GLM | Weigh all three, rule |
| 6 | Citation Clerk | *no model* | — | Check every cited source against CrossRef |

Everything that can overlap does: retrieval runs alongside decomposition, the
three briefs run concurrently, and citation checking runs alongside the ruling.
A full trial takes **~7 seconds** end to end.

Five roles, five distinct model families, two providers. That matters: the
Prosecution and the Defense come from genuinely different pretraining
distributions, so their briefs are independent rather than one model arguing
with itself.

Model IDs are verified against each provider's live `/v1/models` catalog at
startup and degrade to the next candidate if one disappears — see
`ROSTER` in [`veritas/config.py`](veritas/config.py).

---

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env    # then add a key
```

You need **one** API key. [Cerebras](https://cloud.cerebras.ai) and
[Groq](https://console.groq.com) both have free tiers, and between them they
serve every model in the roster. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are
picked up automatically if present and take over the roles they suit better.

```bash
python cli.py --models    # live catalog + who got assigned what
```

## Usage

```bash
python cli.py "vaccines cause autism"              # full trial, all briefs
python cli.py -q "we only use 10% of our brains"   # verdict only
python cli.py --json "nuclear power is safe" > verdict.json
python cli.py --no-ground --no-citations "..."     # skip retrieval / citation audit
python web.py --open                               # courtroom in a browser
python selftest.py                                 # 115 offline tests, no key needed
```

The web UI streams progress over Server-Sent Events, so you watch each party
file its brief in real time. `GET /api/verdict?claim=...` returns the same
trial as plain JSON.

### Browser extension

`extension/` is an unpacked MV3 extension: select any claim on any page,
right-click, and get a verdict overlay. Load it via `chrome://extensions` →
Developer mode → *Load unpacked* → pick the `extension/` folder, with
`python web.py` running. It only ever talks to your local server — the API keys
never leave your machine.

---

## The prompt engineering

This is the actual substance of the project; the plumbing is just plumbing.
All five prompts live in [`veritas/prompts.py`](veritas/prompts.py).

**Persona before task.** Every node opens by fixing an identity and a duty.
"You are THE PROSECUTION and your duty is to find the strongest case against"
produces far less hedging than "evaluate this claim."

**Adversarial licensing.** The hard problem is getting a model to argue *for*
something it believes is false. The Defense prompt solves it by explaining the
epistemics rather than issuing an order:

> *A verdict reached without a real defense is worthless — you cannot know a
> claim is false until someone competent has tried to defend it.*

Measured across five claims including "vaccines cause autism," the Defense
filed real evidence **5/5 times** and never refused or broke character.

**Honesty as the safety valve, not silence.** Both advocates must fill a
`concessions` field, and both commit to a numeric 0–100 confidence *before*
arguing. This decouples "argue hard" from "report honestly" — on "vaccines
cause autism" the Defense filed a full brief and scored its own case **1/100**.
The Judge reads those scores as a quantitative prior before reading any rhetoric.

**Anti-hedging on the bench.** The Judge is told that retreating to MIXED when
the record supports a real verdict "is a failure of nerve," and is given
explicit score bands per label. Verdicts across the test sweep: vaccines/autism
**FALSE (5)**, 10%-of-brains **FALSE (5)**, eight-glasses-of-water **FALSE (10)**,
nuclear-vs-coal **TRUE (90)**, social-media-and-depression **MIXED (50)**.
That last one is the interesting case — it *should* be mixed, and the system
says so with four specific nuances rather than a shrug.

---

## Making open models emit clean JSON

Every node returns typed JSON so the Judge's inputs are structured rather than
parsed out of prose. Getting there took real work — these are failure modes
observed from live models, not hypotheticals, and each has a regression test in
[`selftest.py`](selftest.py):

- **Markdown fences** around the payload
- **`<think>` blocks** from reasoning models, including ones truncated
  mid-thought so only the closing tag survives
- **Unquoted string values** — `llama-3.3-70b-versatile` reliably emits
  `"headline": The claim is false,` with no quotes. The object is otherwise
  perfect, so it gets repaired rather than discarded.
- **Truncation** mid-string or mid-array when a model runs out of budget;
  open brackets are closed and the partial brief is salvaged
- **Schema drift** — `arguments` for `evidence`, `findings` for `key_findings`,
  scores as `72`, `"72"`, `"72/100"`, or `0.72`

Only if all salvage fails does the node re-ask, and the repair prompt is
*appended to the live conversation* rather than replacing it. An earlier version
replaced the history, and the Judge — having lost the briefs it was meant to
rule on — solemnly reported that no arguments had been provided.

Reasoning models also get 2.5× the token budget, because they spend most of it
inside `<think>` before writing a single character of JSON.

## Grounding: the court does its own research

Before anyone argues, three indexes are queried concurrently — none needs a key:

- **CrossRef** for recent peer-reviewed literature
- **Wikipedia** for the standard summary of the dispute
- **DuckDuckGo** for coverage that postdates every model in the roster

The results are entered into the record and injected into all four downstream
prompts, framed explicitly as *evidence, not instruction* — a retrieved page
is not authoritative merely because it is recent, and the prompt says so. This
matters: retrieved text is untrusted input, and a model that treats search
results as commands is a prompt-injection vector.

An earlier version delegated this to Groq's agentic `compound` models. They
work, but the free tier's quota for them is small enough that grounding failed
more often than it succeeded. Direct retrieval is faster, quota-free, and shows
the user real URLs instead of a model's summary of them.

## Citation auditing: the honest part

Every advocate is told never to fabricate a source. Nothing used to enforce
that, which was the biggest gap in the system — an invented paper would be
weighed as evidence like any other. Now every cited source is classified and
the checkable ones go to CrossRef:

| Status | Meaning |
|---|---|
| `verified` | DOI resolves, or author **and** title match a real record |
| `partial` | Work exists but the citation is imprecise, misattributed, or gave no title |
| `unverified` | **Nothing matches — treat as unsupported.** The fabrication signal |
| `unchecked` | CrossRef was unreachable. Explicitly *not* a pass |
| `journal_only` / `institutional` / `unsourced` | Names no specific work; nothing to look up |

Two design rules earned through failure:

**A lookup that didn't happen is never a pass.** The first version reported
network errors as "institutional", so a fabricated citation sailed through
because CrossRef happened to rate-limit. `unchecked` exists to make that
impossible.

**Precision over recall.** Falsely accusing a real paper of being fabricated is
worse than missing a fake one. A common surname alone proves nothing —
CrossRef will return a paper by *some* Taylor about anything at all — so an
author match with an unrelated title reports "could not confirm" and shows no
match, rather than stamping a verdict on the wrong paper. Measured on a fixed
set: **0 false accusations across 5 real papers, 3/3 fabrications caught**
(including an invented DOI), 0 vague prose wrongly accused.

## Failure is not fatal

A dead node doesn't kill the trial. The Judge is told which parties failed to
appear and lowers its confidence accordingly, and if the Judge itself dies the
verdict falls back to the advocates' own confidence scores, clearly marked
provisional. Retrieval and citation checking degrade independently — either can
fail completely and the trial still returns a verdict, with the UI saying which
happened.

---

## What's next

- **Claim-level source checking** — verification currently confirms a cited
  work *exists*; it does not confirm the work says what the advocate claims it
  says. That needs abstract retrieval and an entailment check, and it is the
  honest remaining gap.
- **Multi-language support** — the roster handles it, the prompts don't yet
- **Hosted demo** — the server is stdlib-only and holds keys, so it wants a
  small container rather than a serverless deploy

## Layout

```
veritas/
  config.py      provider registry, role roster, live catalog validation
  prompts.py     the five personas
  engine.py      orchestration, parallel stages, normalization
  grounding.py   pre-trial retrieval (CrossRef + Wikipedia + DuckDuckGo)
  citations.py   post-trial CrossRef verification of every cited source
  jsonio.py      JSON extraction, salvage, repair
  providers.py   async clients (OpenAI wire format + Anthropic)
  schemas.py     node output shapes
cli.py           terminal courtroom
web.py           SSE web courtroom (stdlib http.server, no framework)
extension/       MV3 browser extension (right-click any claim)
selftest.py      115 offline tests
```

*ReverieHacks 2026 · ML Prompt Engineering Track*
