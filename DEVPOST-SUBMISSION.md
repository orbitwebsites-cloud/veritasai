# Devpost submission — copy/paste fields

Each section below maps to one field on the ReverieHacks submission form.

---

## FIELD: Elevator pitch  *(short tagline, ~200 char limit)*

```
Fact-checking as an adversarial trial. Five open models argue opposite sides of a claim, a judge rules 0–100, and every citation is checked against CrossRef — fabricated sources get flagged. ~8 seconds.
```

---

## FIELD: About the project  *(paste the block below as Markdown)*

## Every claim deserves a trial

Ask any single LLM whether social media causes teen depression and you get the
same shrug: *"correlation isn't causation, more research is needed."* It isn't
wrong. It's just useless — you can't do anything with it.

The legal system solved this problem a long time ago. The way to find truth
isn't to ask one person what they think. It's to force the strongest possible
case for each side, then let a neutral party decide. We wanted to know whether
that structure would work if the advocates were LLMs.

It does — and the reason is more interesting than we expected. **A model given a
role and a duty stops hedging.** Hedging is what a model does when it has no
stake. Give it a side to argue and it goes and finds the evidence.

**Live app: https://veritasai-xi.vercel.app**

## What it does

VeritasAI runs a claim through a seven-stage adversarial pipeline in about eight
seconds:

| # | Stage | Model | Family |
|---|-------|-------|--------|
| 0 | **Court Researcher** — retrieves live evidence before anyone argues | *no model* | CrossRef + Wikipedia + DuckDuckGo |
| 1 | **Claim Decomposer** — splits the claim into checkable sub-claims | `llama-3.1-8b-instant` | Llama |
| 2 | **The Prosecution** — strongest case the claim is **false** | `llama-3.3-70b-versatile` | Llama |
| 3 | **Expert Witness** — neutral read on what the evidence says | `gpt-oss-120b` | GPT-OSS |
| 4 | **The Defense** — strongest case the claim is **true** | `gemma-4-31b` | Gemma |
| 5 | **The Judge** — weighs all three briefs and rules | `zai-glm-4.7` | GLM |
| 6 | **Citation Clerk** — verifies every cited source against CrossRef | *no model* | CrossRef |

The verdict is a label (TRUE → FALSE), a 0–100 truth score, a confidence rating,
the reasoning, the strongest argument each way, specific nuances, and a citation
audit that flags sources that don't exist.

Five roles, five **different model families**, two providers. That matters: the
Prosecution (Llama) and the Defense (Gemma) come from different pretraining
distributions on purpose. The whole premise collapses if both briefs are one
model arguing with itself.

## How we built it

Python 3.14 for the reference implementation (CLI + browser extension), then a
TypeScript port on **Next.js 15 + Tailwind v4**, deployed to **Vercel**. All five
models run on the free tiers of **Cerebras** and **Groq**. The web UI streams
progress over Server-Sent Events, so you watch each party file its brief live.

Everything that can overlap does: retrieval runs alongside decomposition, the
three briefs run concurrently, and the citation audit runs alongside the ruling.

### The prompt engineering is the actual project

- **Persona before task.** Every node opens by fixing an identity and a duty, not
  a question. This is the single biggest lever on hedging.
- **Adversarial licensing via epistemics, not orders.** The Defense is told *why*
  its job is legitimate — *"you cannot know a claim is false until someone
  competent has tried to defend it"* — rather than commanded to comply.
- **Mandatory concessions.** Both advocates must concede points. This is what
  lets a model argue hard without feeling it's lying, and it hands the Judge a
  pre-marked map of where the sides already agree.
- **Numeric confidence before prose.** Each advocate commits to a 0–100 score,
  giving the Judge a quantitative prior before it reads any rhetoric.
- **Explicit anti-hedging on the bench.** The Judge is told that retreating to
  MIXED when the record supports a real verdict is *"a failure of nerve"*, and is
  given score bands per verdict label.

## Challenges we ran into

**Getting a model to argue for something it "knows" is false.** This was the core
problem. Direct instruction fails — models break character and emit a disclaimer
instead of a brief. What worked was explaining the epistemic role of a defense and
pairing it with a mandatory `concessions` field and an honest confidence score.
That decouples *argue hard* from *report honestly*, and once a model has somewhere
to put its actual belief, it stops fighting the task.

**JSON from open-weight models.** Far harder than expected, and all of these were
observed live rather than anticipated:
- Reasoning models emitting `<think>` blocks, sometimes truncated mid-thought
- `llama-3.3-70b-versatile` reliably emitting **unquoted string values** —
  `"headline": The claim is false,` — with the rest of the object perfect
- Responses truncated mid-string when a model ran out of budget
- Schema drift: `arguments` for `evidence`, scores as `72` / `"72"` / `"72/100"` / `0.72`

We built a layered salvage path — strip, close, quote, re-ask — and only fall back
to a repair round trip when all of it fails.

**A repair loop that made things worse.** Our first repair implementation replaced
the conversation history with the repair instruction. The Judge, having lost the
briefs it was supposed to rule on, solemnly reported that no arguments had been
provided — and returned a confident-looking MIXED 50/100. It looked like a model
failure. It was our bug.

**Model IDs that didn't exist.** We hardcoded a roster from memory and every single
ID was wrong. The roster is now verified against each provider's live `/v1/models`
endpoint at startup. That check is also what caught the bug — without it, all five
roles silently collapsed onto one model and the "multi-model" premise would have
quietly been a lie.

**A citation checker that let fabrications through.** The first version reported
CrossRef network errors as *"institutional source, not checked"* — so when CrossRef
rate-limited us, an invented citation came back looking clean. **The feature built
to catch fabrication was hiding it.** There's now an explicit `unchecked` status
that can never read as a pass.

**Then it started accusing real papers.** Matching on author surname alone,
"Taylor LE et al." matched a random paper by a different Taylor, and a real vaccine
meta-analysis got matched against a paper on *learning Arabic as a second
language*. We rebuilt the matcher to require title corroboration and to distinguish
misattribution from fabrication.

## Accomplishments we're proud of

**The Defense never refused.** Across five claims including *"vaccines cause
autism"*, it filed real evidence 5/5 times and stayed in character — while scoring
its own case at **1/100** on the vaccine claim. Arguing hard and reporting honestly
at the same time is exactly what we set out to build.

**The verdicts are calibrated, not mush.** vaccines/autism **FALSE (5)**,
10%-of-brains **FALSE (5)**, eight-glasses-of-water **FALSE (10)**, nuclear-vs-coal
**TRUE (90)**, social-media-and-depression **MIXED (45)**. The system commits when
the record supports it and reserves MIXED for claims that are genuinely part-true.

**The Judge cites the concessions.** On the Great Wall claim it ruled MOSTLY FALSE
specifically because *"the Defense concedes that the Wall is not visible under
average conditions"* — it used the adversarial structure rather than averaging two
opinions. That's the whole thesis working.

**The citation audit catches fabrications in real output.** On a live
"vaccines cause autism" trial it flagged 3 of 9 checkable citations as unfindable
while correctly verifying the real ones against their actual DOIs. Measured on a
fixed benchmark: **0 false accusations across 5 real papers, 3/3 fabrications
caught** including an invented DOI.

**It survives its own failures.** A dead node doesn't kill the trial — the Judge is
told who failed to appear and lowers its confidence. Free tiers answer concurrent
bursts with `429`, so a role whose provider fails moves to a different provider.
That change took us from losing a brief roughly every third trial to **30/30 nodes
across five consecutive trials**.

## What we learned

Role assignment does more work than model capability. An 8B model with a sharp
persona and a strict schema outperforms a much larger model asked an open
question, because most of what makes single-model fact-checking frustrating is the
absence of a *stake*, not the absence of knowledge.

We also learned that "multi-model" is easy to claim and easy to accidentally not
have. Ours silently degraded to one model for all five roles and looked completely
fine from the outside.

The broadest lesson came from the citation work: **a verification feature that
fails open is worse than no verification feature**, because it converts
"unchecked" into "looks checked." Both of our worst bugs had that shape — a repair
loop that silently dropped the evidence, and an audit that silently passed
fabrications. Neither threw an error. Both produced confident, plausible, wrong
output. That is the characteristic failure mode of LLM systems, and most of our
engineering went into making failures loud.

## What's next

- **Claim-level source checking.** Verification confirms a cited work *exists*. It
  does not yet confirm the work says what the advocate claims it says — that needs
  abstract retrieval plus an entailment check. This is the honest remaining gap.
- **A search API that datacenters can reach.** DuckDuckGo blocks Vercel's IPs, so
  the deployed app grounds on CrossRef + Wikipedia only.
- **Multi-language support** — the model roster handles it, the prompts don't yet.

---

## FIELD: Built with  *(tags — 24 of the 25 allowed)*

```
python, typescript, next.js, react, tailwindcss, vercel, cerebras, groq,
llama, gemma, gpt-oss, glm, asyncio, server-sent-events, crossref-api,
wikipedia-api, duckduckgo, chrome-extension, node.js, openai-api, rich,
json, html, css
```

---

## FIELD: "Try it out" links

```
https://veritasai-xi.vercel.app
https://github.com/orbitwebsites-cloud/veritasai
```

⚠️ The GitHub repo is currently **private** — judges won't be able to open that
second link. Make it public before submitting:

```bash
gh repo edit orbitwebsites-cloud/veritasai --visibility public
```

---

## FIELD: Video demo link

Not recorded yet. Best demo flow, ~60 seconds:

1. Open https://veritasai-xi.vercel.app
2. Click **"Vaccines cause autism"** — narrate the seven stages lighting up live
3. Land on **FALSE 5/100**, then scroll to the **Defense** panel: it argued the
   case with real evidence *and* scored itself 5/100. That contrast is the
   money shot.
4. Scroll to the **Citation audit** and point at a red ✗ — a source the models
   cited that does not exist in CrossRef
5. Close on the **trial record** table: five models, two providers, ~8 seconds
