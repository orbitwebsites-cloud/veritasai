# VeritasAI — Devpost Submission

> **Note:** this replaces the earlier draft. That draft described a roster of
> GPT-4o / Claude / Gemini nodes and an async speedup listed as future work.
> What actually got built runs on five open-weight models across two free-tier
> providers, and the parallel execution is shipped. Every number below is
> measured from a real run, not projected.

## Project Name
**VeritasAI**

## Tagline
*Every claim deserves a trial.*

## Track
**ML Prompt Engineering**

---

## Inspiration

Ask any single LLM whether social media causes teen depression and you get the
same shrug: "correlation isn't causation, more research is needed." It's not
wrong. It's just useless — you can't do anything with it.

The legal system solved this a long time ago. The way to find truth isn't to
ask one person what they think. It's to force the strongest possible case for
each side, then let a neutral party decide. We wanted to know whether that
structure would work if the advocates were LLMs.

It does, and the reason is more interesting than we expected: a model given a
*role* and a *duty* stops hedging. Hedging is what a model does when it has no
stake. Give it a side to argue and it goes and finds the evidence.

---

## What It Does

VeritasAI puts a claim through a seven-stage adversarial pipeline in about
seven seconds:

0. **Court Researcher** — before anyone argues, queries CrossRef, Wikipedia,
   and DuckDuckGo concurrently and enters the results into the record, so the
   parties argue from current evidence rather than training data.

1. **Claim Decomposer** — splits the claim into 3–5 specific checkable
   sub-claims, tags the domain, and flags every ambiguous term the two sides
   would fight over.
2. **The Prosecution** — builds the strongest case the claim is **false**.
   Attacks methodology, effect sizes, confounders. Commits to a 0–100 score.
3. **Expert Witness** — court-appointed and neutral. Reports what the expert
   community actually holds, including where it's genuinely divided.
4. **The Defense** — steelmans the claim. Finds the strongest *credible* case
   it's true. Commits to its own 0–100 score.
5. **The Judge** — weighs all three briefs and rules: verdict label, truth
   score 0–100, confidence, reasoning, strongest argument each way, nuances,
   and recommended reading.

6. **Citation Clerk** — takes every source the advocates cited and checks it
   against CrossRef. Sources that don't resolve are flagged in the verdict as
   unsupported.

There's a CLI, a web courtroom that streams progress live, and a browser
extension that puts any claim on any page on trial from the right-click menu.

---

## How We Built It

Python 3.14, `asyncio`, and the OpenAI SDK pointed at two free-tier providers.
The web UI is stdlib `http.server` with Server-Sent Events — no framework, no
build step, no `node_modules`.

| Node | Model | Family | Provider |
|------|-------|--------|----------|
| Decomposer | `llama-3.1-8b-instant` | Llama | Groq |
| Prosecution | `llama-3.3-70b-versatile` | Llama | Groq |
| Expert Witness | `gpt-oss-120b` | GPT-OSS | Cerebras |
| Defense | `gemma-4-31b` | Gemma | Cerebras |
| Judge | `zai-glm-4.7` | GLM | Cerebras |

Five roles, five distinct model families. The Prosecution (Llama) and the
Defense (Gemma) come from different pretraining distributions on purpose — the
whole premise collapses if both briefs are one model arguing with itself.

Nodes 2–4 are independent, so they run concurrently. Full trial: **~6s**.

**The prompt engineering decisions that mattered:**

- **Persona before task.** Every node opens by fixing an identity and a duty,
  not a question. This is the single biggest lever on hedging.
- **Adversarial licensing via epistemics, not orders.** The Defense is told
  *why* its job is legitimate — "you cannot know a claim is false until someone
  competent has tried to defend it" — rather than being commanded to comply.
- **Mandatory concessions.** Both advocates must concede points. This is what
  lets a model argue hard without feeling it's lying, and it hands the Judge a
  pre-marked map of where the sides already agree.
- **Numeric confidence before prose.** Each advocate commits to a score, giving
  the Judge a quantitative prior before it reads any rhetoric.
- **Explicit anti-hedging on the bench.** The Judge is told that retreating to
  MIXED when the record supports a real verdict is "a failure of nerve," and is
  given score bands per verdict label.

---

## Challenges We Ran Into

**Getting a model to argue for something it "knows" is false.** This was the
core problem. Direct instruction fails — models break character and emit a
disclaimer instead of a brief. What worked was explaining the epistemic role of
a defense and pairing it with a mandatory `concessions` field and an honest
confidence score. That decouples "argue hard" from "report honestly," and once
a model has somewhere to put its actual belief, it stops fighting the task.

**JSON from open-weight models.** Far harder than expected, and all of these
were observed live rather than anticipated:
- Reasoning models emitting `<think>` blocks, sometimes truncated mid-thought
- `llama-3.3-70b-versatile` reliably emitting **unquoted string values** —
  `"headline": The claim is false,` — with the rest of the object perfect
- Responses truncated mid-string when a model ran out of budget
- Schema drift: `arguments` for `evidence`, scores as `72` / `"72"` / `"72/100"` / `0.72`

We built a layered salvage path — strip, close, quote, re-ask — and only fall
back to a repair round trip when all of it fails.

**A repair loop that made things worse.** Our first repair implementation
replaced the conversation history with the repair instruction. The Judge, having
lost the briefs it was supposed to rule on, solemnly reported that no arguments
had been provided — and returned a confident-looking MIXED 50/100. It looked
like a model failure. It was our bug. The fix was to append the correction to
the live conversation instead of replacing it.

**Model IDs that didn't exist.** We hardcoded a roster from memory and every
single ID was wrong. Now the roster is verified against each provider's live
`/v1/models` endpoint at startup and degrades to the next candidate
automatically — which is also what caught the bug, because otherwise all five
roles silently collapsed onto one model and the "multi-model" premise would
have quietly been a lie.

**A citation checker that let fabrications through.** The first version
reported CrossRef network errors as "institutional source, not checked" — so
when CrossRef rate-limited us, an invented citation came back looking clean.
The feature built to catch fabrication was hiding it. There is now an explicit
`unchecked` status that can never read as a pass.

**Then it started accusing real papers.** Matching on author surname alone,
"Taylor LE et al." matched a random paper by a different Taylor, and a real
vaccine meta-analysis got matched against a paper on *learning Arabic as a
second language*. We rebuilt the matcher to require title corroboration, to
distinguish misattribution from fabrication, and to show no match at all rather
than a wrong one. Measured on a fixed set afterwards: 0 false accusations
across 5 real papers, 3/3 fabrications caught including an invented DOI.
For a fact-checking tool, precision beats recall — falsely calling a real
citation fake is worse than missing a fake one.

---

## Accomplishments We're Proud Of

**The Defense never refused.** Across five claims including "vaccines cause
autism," it filed real evidence 5/5 times and stayed in character — while
scoring its own case at **1/100** on the vaccine claim. Arguing hard and
reporting honestly at the same time is exactly what we were trying to build.

**The verdicts are calibrated, not mush.** vaccines/autism **FALSE (5)**,
10%-of-brains **FALSE (5)**, eight-glasses-of-water **FALSE (10)**,
nuclear-vs-coal **TRUE (90)**, social-media-and-depression **MIXED (50)**. The
system commits when the record supports it and reserves MIXED for claims that
are genuinely part-true.

**The Judge cites the concessions.** On the Great Wall claim it ruled MOSTLY
FALSE specifically because *"the Defense concedes that the Wall is not visible
under average conditions"* — it used the adversarial structure rather than
just averaging two opinions. That's the whole thesis working.

**The citation audit catches fabrications in real output.** On a live "vaccines
cause autism" trial it flagged 3 of 9 checkable citations as unfindable, while
correctly verifying the real ones against their actual DOIs. Being able to say
*which* pieces of a verdict rest on sources that don't exist is the difference
between a demo and something you'd let near a newsroom.

**It survives its own failures.** A dead node doesn't kill the trial; the Judge
is told who failed to appear and lowers its confidence. Retrieval and citation
checking degrade independently. 115 offline tests cover salvage, orchestration,
retrieval, and citation matching, and run with no API key.

---

## What We Learned

Role assignment does more work than model capability. An 8B model with a sharp
persona and a strict schema outperforms a much larger model asked an open
question, because most of what makes single-model fact-checking frustrating is
the absence of a stake, not the absence of knowledge.

We also learned that "multi-model" is easy to claim and easy to accidentally
not have. Ours silently degraded to one model for all five roles and looked
completely fine from the outside. Verifying the roster at runtime is the only
reason we know the diversity is real.

The broader lesson from the citation work: **a verification feature that fails
open is worse than no verification feature**, because it converts "unchecked"
into "looks checked." Both of our worst bugs were that shape — a repair loop
that silently dropped the evidence, and an audit that silently passed
fabrications. Neither threw an error. Both produced confident, plausible,
wrong output. That is the characteristic failure mode of LLM systems, and
almost all of our engineering effort went into making failures loud.

---

## What's Next

- **Claim-level source checking.** Verification confirms a cited work exists.
  It does not yet confirm the work *says what the advocate claims it says* —
  that needs abstract retrieval plus an entailment check. This is the honest
  remaining gap.
- **Multi-language support** — the model roster handles it, the prompts don't yet.
- **Hosted demo** — the server is stdlib-only and holds API keys, so it wants a
  small container rather than a serverless deploy.

## Built With

`python` · `asyncio` · `openai` · `cerebras` · `groq` · `llama` · `gemma` ·
`gpt-oss` · `glm` · `crossref` · `wikipedia` · `duckduckgo` ·
`server-sent-events` · `chrome-extension` · `rich`

## Try It Out

- **Live app: https://veritasai-xi.vercel.app**
- GitHub: [link]
- Demo Video: [link]

---

*VeritasAI — ReverieHacks 2026 · ML Prompt Engineering Track*
