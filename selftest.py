"""Offline self-test: exercises every code path that does not need an API key.

    python selftest.py

Covers the JSON recovery layer (the thing most likely to break on a new model),
normalization of sloppy model output, verdict/score reconciliation, roster
resolution against a fake catalog, and a full end-to-end trial against a stub
provider so the orchestration is proven before a single token is spent.
"""

from __future__ import annotations

import asyncio
import json
import sys

from veritas import config as cfg, engine, providers
from veritas.config import Assignment, DECOMPOSER, DEFENSE, EXPERT, JUDGE, PROSECUTION, PROVIDERS
from veritas.jsonio import JSONRecoveryError, coerce_int, extract_json

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {detail}")


print("\n[1] JSON recovery — the failure modes real models actually produce")
cases = {
    "bare object": '{"a": 1}',
    "markdown fence": '```json\n{"a": 1}\n```',
    "fence, no lang": '```\n{"a": 1}\n```',
    "prose preamble": 'Here is the analysis:\n{"a": 1}',
    "reasoning block": '<think>let me consider...</think>\n{"a": 1}',
    "truncated think": 'blah blah</think>{"a": 1}',
    "trailing comma": '{"a": 1,}',
    "trailing prose": '{"a": 1}\nHope that helps!',
    "brace in string": '{"a": 1, "s": "a } brace"}',
    "nested + fence + think": '<think>x</think>```json\n{"a": 1, "n": {"b": [1,2]}}\n```',
}
for name, raw in cases.items():
    try:
        check(name, extract_json(raw).get("a") == 1)
    except JSONRecoveryError as exc:
        check(name, False, str(exc))

print("\n[1b] Salvage — malformations observed from live models")
# Verbatim shape emitted by llama-3.3-70b-versatile: a string value with no
# quotes around it. Everything else about the object was valid.
bare = '''{
  "confidence": 95,
  "headline": The Great Wall is not visible from space due to its width,
  "evidence": [{"point": "30 feet wide", "source": "NASA", "strength": "strong"}]
}'''
try:
    got = extract_json(bare)
    check("unquoted string value (llama-3.3-70b)",
          got["confidence"] == 95 and got["headline"].startswith("The Great Wall"),
          json.dumps(got)[:120])
    check("salvage preserves the rest of the object", len(got["evidence"]) == 1)
except JSONRecoveryError as exc:
    check("unquoted string value (llama-3.3-70b)", False, str(exc))

truncated = '{"confidence": 88, "headline": "cut off here", "evidence": [{"point": "a partial'
try:
    got = extract_json(truncated)
    check("truncated mid-string is closed and salvaged", got["confidence"] == 88, json.dumps(got)[:120])
except JSONRecoveryError as exc:
    check("truncated mid-string is closed and salvaged", False, str(exc))

truncated2 = '{"confidence": 70, "evidence": [{"point": "p", "source": "s"}], "concessions": ['
try:
    check("truncated at an open array", extract_json(truncated2)["confidence"] == 70)
except JSONRecoveryError as exc:
    check("truncated at an open array", False, str(exc))

dangling = '{"confidence": 70, "headline":'
try:
    check("truncated on a dangling key", extract_json(dangling)["confidence"] == 70)
except JSONRecoveryError as exc:
    check("truncated on a dangling key", False, str(exc))

# Salvage must not corrupt input that was already valid.
good = '{"a": 1, "b": [1,2], "c": {"d": true}, "e": null, "f": -3.5, "g": "x: y"}'
check("salvage leaves valid JSON untouched", extract_json(good) == json.loads(good))

for name, raw in {"empty": "", "no json": "I cannot answer that."}.items():
    try:
        extract_json(raw)
        check(f"rejects {name}", False, "should have raised")
    except JSONRecoveryError:
        check(f"rejects {name}", True)

print("\n[2] Score coercion — models return scores in five different shapes")
for raw, want in [(72, 72), ("72", 72), ("72/100", 72), (0.72, 72), ("about 85%", 85),
                  (150, 100), (-5, 0), (None, 50), (True, 50), ("n/a", 50)]:
    check(f"{raw!r} -> {want}", coerce_int(raw) == want, f"got {coerce_int(raw)}")

print("\n[3] Verdict reconciliation")
v = engine._norm_verdict({"verdict": "MOSTLY TRUE", "truth_score": 12}, 50, 50)
check("label wins over contradicting score", v["truth_score"] == 61 and v["verdict"] == "MOSTLY TRUE",
      json.dumps(v, default=str)[:120])
v = engine._norm_verdict({"truth_score": 90}, 50, 50)
check("label derived when missing", v["verdict"] == "TRUE")
v = engine._norm_verdict({"verdict": "true", "truth_score": "88/100", "confidence": "HIGH"}, 50, 50)
check("case-insensitive label + conf", v["verdict"] == "TRUE" and v["confidence"] == "High")
v = engine._norm_verdict(None, 80, 20)
check("judge failure falls back to advocates", v["truth_score"] == 20 and v["confidence"] == "Low",
      json.dumps(v, default=str)[:120])

print("\n[4] Normalization of sloppy but valid model output")
d = engine._norm_docket({"sub_claims": ["a plain string sub-claim"], "domain": "science"}, "c")
check("string sub-claims get ids", d["sub_claims"][0]["id"] == "S1")
d = engine._norm_docket(None, "the original claim")
check("null docket falls back to the claim", d["sub_claims"][0]["text"] == "the original claim")
a = engine._norm_advocate({"confidence": "70", "arguments": ["bare string evidence"]})
check("aliased key 'arguments' accepted", a["evidence"][0]["point"] == "bare string evidence")
check("missing strength defaults", a["evidence"][0]["strength"] == "weak")
e = engine._norm_expert({"certainty": 90, "findings": [{"finding": "f", "source": "s"}]})
check("aliased key 'findings' accepted", e["key_findings"][0]["year"] == "unknown")

print("\n[5] Roster resolution")
import os

# Isolate to a single fake provider so a real key in .env cannot change the
# outcome of these assertions.
os_key = "CEREBRAS_API_KEY"
saved = {p.api_key_env: os.environ.get(p.api_key_env) for p in PROVIDERS.values()}
for env_name in saved:
    os.environ.pop(env_name, None)
os.environ[os_key] = "sk-test-fake"
try:
    by_provider: dict[str, set[str]] = {}
    for candidates in cfg.ROSTER.values():
        for pname, model in candidates:
            by_provider.setdefault(pname, set()).add(model)

    # Single provider live: roles must all still fill, even though several will
    # necessarily share a model.
    roster = cfg.resolve_roster({"cerebras": by_provider["cerebras"]})
    check("all 5 roles assigned", len(roster) == 5 and all(r in roster for r in cfg.ROLES))
    check("single provider still fills every role",
          all(a.provider.name == "cerebras" for a in roster.values()))

    # Both free-tier providers live: this is the real deployment, and the whole
    # premise depends on the five roles not collapsing onto one model.
    os.environ["GROQ_API_KEY"] = "gsk-test-fake"
    both = cfg.resolve_roster({k: v for k, v in by_provider.items() if k in ("cerebras", "groq")})
    models = {a.model for a in both.values()}
    check("five roles -> five distinct models", len(models) == 5, str(sorted(models)))
    check("advocates come from different model families",
          both[cfg.PROSECUTION].model != both[cfg.DEFENSE].model,
          f"{both[cfg.PROSECUTION].model} vs {both[cfg.DEFENSE].model}")
    os.environ.pop("GROQ_API_KEY", None)

    # Catalog only serves one model: everything must degrade onto it, not crash.
    only = next(m for _, m in cfg.ROSTER[cfg.JUDGE] if _ == "cerebras")
    degraded = cfg.resolve_roster({"cerebras": {only}})
    check("degrades to the only live model",
          all(a.model == only for a in degraded.values()),
          str({r: a.model for r, a in degraded.items()}))

    # Model IDs drifted entirely -> fall back rather than raise.
    check("survives a fully unknown catalog",
          len(cfg.resolve_roster({"cerebras": {"some-new-model-id"}})) == 5)
finally:
    os.environ.pop(os_key, None)

try:
    cfg.resolve_roster(None)
    check("raises with no keys", False, "should have raised NoProviderError")
except cfg.NoProviderError:
    check("raises with no keys", True)
finally:
    for env_name, val in saved.items():
        if val is not None:
            os.environ[env_name] = val

print("\n[6] End-to-end trial against a stub provider")

CANNED = {
    DECOMPOSER: '```json\n{"domain":"science","claim_type":"factual","sub_claims":["visible to the naked eye from LEO"],"ambiguities":["space"]}\n```',
    PROSECUTION: '<think>reasoning</think>{"confidence":88,"headline":"Not visible unaided.","evidence":[{"point":"Wall is ~30ft wide","source":"NASA","strength":"strong"}],"fallacies":["equivocation on space"],"concessions":["visible with optical aid"]}',
    EXPERT: '{"certainty":92,"consensus":"Not visible to the unaided eye from LEO.","key_findings":[{"finding":"Astronaut reports negative","source":"NASA","year":"2003"}],"open_questions":[],"common_misreadings":["conflating aided and unaided"]}',
    DEFENSE: 'Here you go:\n{"confidence":22,"headline":"True under an aided reading.","evidence":[{"point":"Ed Lu photographed it with optics","source":"ISS Expedition 7","strength":"moderate"}],"fallacies":[],"concessions":["false as commonly stated"]}',
    JUDGE: '```json\n{"verdict":"MOSTLY FALSE","truth_score":22,"confidence":"High","reasoning":"Scope mismatch.","strongest_for":"Aided visibility.","strongest_against":"Too narrow to resolve unaided.","nuances":["depends on optical aid"],"recommended_reading":["NASA Earth Observatory"]}\n```',
}

calls: list[str] = []


async def stub_chat(assignment, system, messages, max_tokens, temperature=0.0):
    calls.append(assignment.role)
    await asyncio.sleep(0.01)
    return CANNED[assignment.role]


providers_chat = engine.chat
engine.chat = stub_chat
try:
    fake = PROVIDERS["cerebras"]
    roster = {r: Assignment(r, fake, f"stub-{r}") for r in cfg.ROLES}
    trial = asyncio.run(engine.try_claim("The Great Wall is visible from space", roster,
                                         ground=False, verify_citations=False))

    check("all 5 nodes ran", len(trial.nodes) == 5 and all(n.ok for n in trial.nodes),
          str([(n.role, n.error) for n in trial.nodes if not n.ok]))
    check("verdict label", trial.verdict["verdict"] == "MOSTLY FALSE")
    check("truth score", trial.verdict["truth_score"] == 22)
    check("briefs attached", set(trial.verdict["_briefs"]) == {"docket", "prosecution", "expert", "defense"})
    check("prosecution confidence parsed through <think>", trial.verdict["_briefs"]["prosecution"]["confidence"] == 88)
    check("defense parsed through prose preamble", trial.verdict["_briefs"]["defense"]["confidence"] == 22)
    check("decomposer ran first", calls[0] == DECOMPOSER)
    check("judge ran last", calls[-1] == JUDGE)
    check("three parties ran between", set(calls[1:4]) == {PROSECUTION, EXPERT, DEFENSE})
    check("serializes to JSON", isinstance(json.dumps(trial.to_dict()), str))

    # A dead node must not kill the trial.
    async def flaky_chat(assignment, system, messages, max_tokens, temperature=0.0):
        if assignment.role == DEFENSE:
            raise providers.ProviderError("simulated 429 rate limit")
        return CANNED[assignment.role]

    engine.chat = flaky_chat
    trial2 = asyncio.run(engine.try_claim("x", roster, ground=False, verify_citations=False))
    check("trial survives a dead node", trial2.verdict is not None and trial2.verdict["verdict"] == "MOSTLY FALSE")
    check("dead node recorded as failed", not trial2.node(DEFENSE).ok)
    check("dead node's brief is None", trial2.verdict["_briefs"]["defense"] is None)

    # Unparseable output must exhaust repairs and then fail cleanly.
    attempts = {"n": 0}

    async def junk_chat(assignment, system, messages, max_tokens, temperature=0.0):
        if assignment.role == EXPERT:
            attempts["n"] += 1
            return "I'm sorry, I can't help with that."
        return CANNED[assignment.role]

    engine.chat = junk_chat
    trial3 = asyncio.run(engine.try_claim("x", roster, ground=False, verify_citations=False))
    check("repair loop retried MAX_REPAIRS times", attempts["n"] == cfg.MAX_REPAIRS + 1, f"got {attempts['n']}")
    check("unparseable node fails cleanly", not trial3.node(EXPERT).ok and trial3.verdict is not None)
finally:
    engine.chat = providers_chat

print("\n[7] Citation classification — deciding what CrossRef can actually check")
from veritas import citations as cit

for src, want in [
    ("Smith, L. M., et al., 'Visual Resolution Limits for Low-Earth-Orbit Observers,' Journal of Applied Optics (2010)", "check"),
    ("Orben, J., & Przybylski, A. K.", "check"),
    ("Keles, B., McCrae, N., & Grealish, A.", "check"),
    ("Twenge, J. M., et al.", "check"),
    # Venue names identify no work; checking them returns editorials that match
    # on title words, which is worse than not checking at all.
    ("The Lancet Child & Adolescent Health", cit.JOURNAL_ONLY),
    ("Journal of Adolescence", cit.JOURNAL_ONLY),
    ("Psychological Science", cit.JOURNAL_ONLY),
    ("NASA Earth Observatory", cit.INSTITUTIONAL),
    ("World Health Organization fact sheet", cit.INSTITUTIONAL),
    ("China State Administration of Cultural Heritage", cit.INSTITUTIONAL),
    ("unspecified", cit.UNSOURCED),
    ("", cit.UNSOURCED),
    ("n/a", cit.UNSOURCED),
]:
    got = cit.classify(src)
    check(f"classify {src[:42]!r} -> {want}", got == want, f"got {got}")

check("surnames extracted from an author list",
      cit.surnames("Keles, B., McCrae, N., & Grealish, A.") == {"keles", "mccrae", "grealish"},
      str(cit.surnames("Keles, B., McCrae, N., & Grealish, A.")))
check("surnames extracted from the 'Lewis (2014)' form",
      cit.surnames("Lewis (2014)") == {"lewis"}, str(cit.surnames("Lewis (2014)")))
check("filler words are not treated as surnames",
      "the" not in cit.surnames("The Stressors (2020)"), str(cit.surnames("The Stressors (2020)")))
check("bare-surname citation becomes checkable", cit.classify("Lewis (2014)") == "check")

check("doi extracted from a source string",
      cit.doi_in("Lewis (2014) doi:10.64628/ab.749j9uquy") == "10.64628/ab.749j9uquy",
      cit.doi_in("Lewis (2014) doi:10.64628/ab.749j9uquy"))
check("doi presence forces a check", cit.classify("see doi:10.1038/s41562-018-0506-1") == "check")
check("no false doi in plain prose", cit.doi_in("NASA Earth Observatory 2005") == "")

# Institutional sources must never be reported as suspect: CrossRef not
# indexing NASA is a fact about CrossRef, not evidence of fabrication.
briefs = {
    "prosecution": {"evidence": [{"source": "NASA Earth Observatory", "point": "p"},
                                 {"source": "unspecified", "point": "q"}]},
    "defense": {"evidence": [{"source": "NASA Earth Observatory", "point": "r"}]},
    "expert": {"key_findings": [{"source": "Nature, 2019", "finding": "f"}]},
}
found = cit.collect_sources(briefs)
check("sources deduplicated across parties", len(found) == 3, str(found))
check("collect keeps party attribution", {p for _, p, _ in found} == {"prosecution", "expert"}, str(found))
check("collect carries the supporting claim text",
      any(point == "p" for _, _, point in found), str(found))

report = asyncio.run(cit.verify_briefs({"prosecution": {"evidence": [{"source": "NASA Earth Observatory", "point": "p"}]}}))
check("institutional source is not flagged", report["flagged"] == 0 and report["checked"] == 0,
      json.dumps(report["summary"]))
check("empty briefs verify cleanly", asyncio.run(cit.verify_briefs({}))["checks"] == [])

print("\n[7b] Citation matching logic — stubbed CrossRef, no network")

KELES = {"title": ["A systematic review: the influence of social media on depression, anxiety and psychological distress in adolescents"],
         "DOI": "10.1080/02673843.2019.1590851", "issued": {"date-parts": [[2019]]},
         "author": [{"family": "Keles"}, {"family": "McCrae"}, {"family": "Grealish"}]}
UNRELATED = {"title": ["Multigenerational social mobility and depressive symptoms"],
             "DOI": "10.1093/x", "issued": {"date-parts": [[2024]]},
             "author": [{"family": "Huang"}, {"family": "Zhou"}]}

real_query = cit._crossref_query
scenarios = {}


async def fake_query(client, query, authors="", attempts=3):
    return scenarios.get("items", []), scenarios.get("error", "")


cit._crossref_query = fake_query
try:
    async def one(source, point=""):
        import httpx
        return await cit._check_one(None, source, "expert", point, asyncio.Semaphore(1))

    # A fabricated work: CrossRef has nothing.
    scenarios = {"items": [], "error": ""}
    r = asyncio.run(one("Fabricated, Q. Z., et al., 'Neural Correlates of Zorbital Displacement' (2021)"))
    check("fabricated citation -> unverified", r.status == cit.UNVERIFIED, r.status)

    # THE critical case: a lookup that failed must never read as a pass.
    scenarios = {"items": [], "error": "HTTP 429"}
    r = asyncio.run(one("Fabricated, Q. Z., et al., 'Neural Correlates of Zorbital Displacement' (2021)"))
    check("failed lookup -> unchecked, never verified", r.status == cit.UNCHECKED, r.status)
    check("unchecked says so explicitly", "NOT verified" in r.detail, r.detail)

    # Author + title both line up.
    scenarios = {"items": [KELES], "error": ""}
    r = asyncio.run(one('Keles, B., McCrae, N., & Grealish, A. "A systematic review: the influence of social media on depression" (2019)'))
    check("author+title+year match -> verified", r.status == cit.VERIFIED, f"{r.status} {r.detail}")
    check("verified attaches the real DOI", r.doi == "10.1080/02673843.2019.1590851", r.doi)

    # Authors real, cited title is not theirs -> must not claim verified.
    scenarios = {"items": [UNRELATED], "error": ""}
    r = asyncio.run(one('Huang, C. et al. "A totally different paper about coral reef bleaching rates"'))
    check("author match with unrelated title -> partial", r.status == cit.PARTIAL, f"{r.status} {r.detail}")
    check("no bogus match is displayed for a title miss", r.matched_title == "",
          f"showed {r.matched_title!r}")

    # No title cited: cannot confirm a specific work, so never verified.
    scenarios = {"items": [KELES], "error": ""}
    r = asyncio.run(one("Keles, B., McCrae, N., & Grealish, A.", "social media and adolescent depression"))
    check("author-only citation caps at partial", r.status == cit.PARTIAL, f"{r.status} {r.detail}")
    check("author-only explains what was not confirmed", "named no title" in r.detail, r.detail)

    # A real work cited under the wrong author is a misattribution, not a
    # fabrication, and must be reported as the former.
    scenarios = {"items": [UNRELATED], "error": ""}
    r = asyncio.run(one('Nonexistent, Z. Q. "Multigenerational social mobility and depressive symptoms"'))
    check("real title, wrong author -> partial not unverified", r.status == cit.PARTIAL, f"{r.status} sim={r.similarity}")
    check("misattribution is named as such", "attribution" in r.detail, r.detail)

    # Nothing matches on either axis -> the fabrication signal.
    scenarios = {"items": [UNRELATED], "error": ""}
    r = asyncio.run(one('Nobody, A. B. "Zorbital displacement in adolescent neural fields" (2021)'))
    check("no author and no title match -> unverified", r.status == cit.UNVERIFIED, f"{r.status} sim={r.similarity}")
finally:
    cit._crossref_query = real_query

print("\n[7c] DOI resolution — the decisive check")
real_resolve = cit._resolve_doi
doi_scenario = {}


async def fake_resolve(client, doi):
    return doi_scenario.get("record"), doi_scenario.get("error", "")


cit._resolve_doi = fake_resolve
try:
    async def one_doi(source):
        return await cit._check_one(None, source, "expert", "", asyncio.Semaphore(1))

    doi_scenario = {"record": {"title": ["The association between adolescent well-being and digital technology use"]}}
    r = asyncio.run(one_doi("Orben & Przybylski, doi:10.1038/s41562-018-0506-1"))
    check("resolving DOI -> verified", r.status == cit.VERIFIED, f"{r.status} {r.detail}")
    check("verified DOI carries the registered title",
          r.matched_title.startswith("The association"), r.matched_title)

    doi_scenario = {"record": None, "error": ""}
    r = asyncio.run(one_doi("Fabricated, Q. 'Zorbital Displacement', doi:10.9999/fake.12345"))
    check("non-resolving DOI -> unverified", r.status == cit.UNVERIFIED, f"{r.status} {r.detail}")
    check("unverified DOI names the bad identifier", "10.9999/fake.12345" in r.detail, r.detail)

    doi_scenario = {"record": None, "error": "HTTP 429"}
    r = asyncio.run(one_doi("Someone, doi:10.1038/abc123"))
    check("unreachable DOI lookup -> unchecked, not a pass", r.status == cit.UNCHECKED, r.status)
finally:
    cit._resolve_doi = real_resolve

print("\n[8] Grounding — rendering and degradation")
from veritas import grounding as gr

check("as_context is empty for a failed search",
      gr.as_context(engine.NodeResult(role="grounding", model="m", provider="p", error="boom")) == "")
check("as_context is empty for None", gr.as_context(None) == "")

ok_node = engine.NodeResult(role="grounding", model="m", provider="p", data={
    "papers": [{"title": "Digital technology and well-being", "authors": "Orben, Przybylski",
                "year": "2019", "journal": "Nature Human Behaviour", "doi": "10.1038/x", "citations": 900}],
    "encyclopedia": [{"title": "Problematic social media use", "snippet": "psychological distress",
                      "url": "https://en.wikipedia.org/wiki/X"}],
    "web": [{"title": "Teens and mental health", "snippet": "a 2025 report", "url": "https://example.com/a"}],
    "sources": ["https://en.wikipedia.org/wiki/X", "https://example.com/a"],
    "counts": {"papers": 1, "encyclopedia": 1, "web": 1},
})
ctx = gr.as_context(ok_node)
for needle in ("Nature Human Behaviour", "10.1038/x", "Problematic social media use", "Teens and mental health"):
    check(f"context carries {needle[:28]!r}", needle in ctx)
check("context warns against treating results as instruction", "not as instruction" in ctx)
check("sources() reads the retrieved URL list", len(gr.sources(ok_node)) == 2)

check("html entities and tags stripped from snippets",
      gr._text('<span class="x">Smith &amp; Jones</span>') == "Smith & Jones",
      gr._text('<span class="x">Smith &amp; Jones</span>'))
check("duckduckgo redirector unwrapped",
      gr._unwrap("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x") == "https://example.com/a",
      gr._unwrap("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x"))
check("plain urls pass through unwrap", gr._unwrap("https://plain.com/x") == "https://plain.com/x")

# CrossRef returns book-chapter noise ("China", "Introduction") for colloquial
# claims. Irrelevant papers in the evidence block are worse than none.
wall = gr._content_words("The Great Wall of China is visible from space")
for title, want, why in [
    ("China", False, "single generic word"),
    ("Introduction", False, "chapter heading"),
    ("Conclusions", False, "chapter heading"),
    ("Management in Transitional Economies", False, "unrelated book"),
    ("Is China's Great Wall visible from space?", True, "on topic"),
    ("Visual resolution limits for observers in space viewing the Great Wall", True, "on topic"),
]:
    check(f"relevance: {title[:44]!r} -> {want} ({why})", gr._relevant(wall, title) == want)

check("stopwords excluded from content words", "the" not in wall and "from" not in wall, str(sorted(wall)))

# A trial with grounding requested but every source failing must still complete.
engine.chat = stub_chat
real_ground = gr.ground


async def dead_ground(claim, timeout=20.0):
    return engine.NodeResult(role="grounding", model="x", provider="direct",
                             error="all retrieval sources failed")


gr.ground = dead_ground
try:
    t = asyncio.run(engine.try_claim("x", roster, ground=True, verify_citations=False))
    check("trial completes when retrieval fails", t.verdict is not None)
    check("failed grounding node is recorded",
          t.node("grounding") is not None and not t.node("grounding").ok)
    check("verdict marks grounding as absent", t.verdict["_grounding"] is None)
finally:
    gr.ground = real_ground
    engine.chat = providers_chat

print(f"\n{'=' * 46}\n  {PASS} passed, {FAIL} failed\n{'=' * 46}")
sys.exit(1 if FAIL else 0)
