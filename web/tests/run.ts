/**
 * Offline test suite for the TypeScript pipeline. No API key, no network.
 *
 *   npm test
 *
 * Mirrors the Python selftest: the JSON salvage layer (the thing most likely to
 * break on a new model), score coercion, verdict reconciliation, roster
 * resolution, citation classification and matching, and grounding relevance.
 */

import {
  classify,
  collectSources,
  doiIn,
  INSTITUTIONAL,
  JOURNAL_ONLY,
  similar,
  surnames,
  UNSOURCED,
} from "../lib/citations.ts";
import {
  NoProviderError,
  PROVIDERS,
  resolveCandidates,
  resolveRoster,
  ROSTER,
} from "../lib/config.ts";
import { contentWords, relevant, unwrap } from "../lib/grounding.ts";
import { asStringList, coerceInt, extractJson, JSONRecoveryError } from "../lib/jsonio.ts";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}  ${detail}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// --- 1. JSON recovery -------------------------------------------------------

section("[1] JSON recovery — failure modes real models actually produce");
const cases: Record<string, string> = {
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
};
for (const [name, raw] of Object.entries(cases)) {
  try {
    check(name, extractJson(raw).a === 1);
  } catch (e) {
    check(name, false, String(e));
  }
}
for (const [name, raw] of Object.entries({ empty: "", "no json": "I cannot answer that." })) {
  try {
    extractJson(raw);
    check(`rejects ${name}`, false, "should have thrown");
  } catch (e) {
    check(`rejects ${name}`, e instanceof JSONRecoveryError);
  }
}

section("[1b] Salvage — malformations observed from live models");
// Verbatim shape from llama-3.3-70b-versatile: an unquoted string value.
const bare = `{
  "confidence": 95,
  "headline": The Great Wall is not visible from space due to its width,
  "evidence": [{"point": "30 feet wide", "source": "NASA", "strength": "strong"}]
}`;
try {
  const got = extractJson(bare);
  check(
    "unquoted string value (llama-3.3-70b)",
    got.confidence === 95 && String(got.headline).startsWith("The Great Wall"),
    JSON.stringify(got).slice(0, 120),
  );
  check("salvage preserves the rest of the object", (got.evidence as unknown[]).length === 1);
} catch (e) {
  check("unquoted string value (llama-3.3-70b)", false, String(e));
}

const truncCases: [string, string, number][] = [
  ["truncated mid-string", '{"confidence": 88, "headline": "cut off here", "evidence": [{"point": "a partial', 88],
  ["truncated at an open array", '{"confidence": 70, "evidence": [{"point": "p"}], "concessions": [', 70],
  ["truncated on a dangling key", '{"confidence": 70, "headline":', 70],
];
for (const [name, raw, want] of truncCases) {
  try {
    check(name, extractJson(raw).confidence === want);
  } catch (e) {
    check(name, false, String(e));
  }
}

const good = '{"a": 1, "b": [1,2], "c": {"d": true}, "e": null, "f": -3.5, "g": "x: y"}';
check(
  "salvage leaves valid JSON untouched",
  JSON.stringify(extractJson(good)) === JSON.stringify(JSON.parse(good)),
  JSON.stringify(extractJson(good)),
);

// --- 2. Coercion ------------------------------------------------------------

section("[2] Score coercion — models return scores in five different shapes");
const coercions: [unknown, number][] = [
  [72, 72], ["72", 72], ["72/100", 72], [0.72, 72], ["about 85%", 85],
  [150, 100], [-5, 0], [null, 50], [true, 50], ["n/a", 50],
];
for (const [raw, want] of coercions) {
  check(`${JSON.stringify(raw)} -> ${want}`, coerceInt(raw) === want, `got ${coerceInt(raw)}`);
}
check("asStringList wraps a bare string", asStringList("x").length === 1);
check("asStringList tolerates null", asStringList(null).length === 0);

// --- 3. Roster --------------------------------------------------------------

section("[3] Roster resolution");
const saved: Record<string, string | undefined> = {};
for (const p of Object.values(PROVIDERS)) {
  saved[p.apiKeyEnv] = process.env[p.apiKeyEnv];
  delete process.env[p.apiKeyEnv];
}
try {
  const byProvider: Record<string, Set<string>> = {};
  for (const candidates of Object.values(ROSTER)) {
    for (const [pname, model] of candidates) {
      (byProvider[pname] ??= new Set()).add(model);
    }
  }

  process.env.CEREBRAS_API_KEY = "sk-test-fake";
  const single = resolveRoster({ cerebras: byProvider.cerebras });
  check("single provider fills every role", Object.keys(single).length === 5);
  check(
    "single provider uses only that provider",
    Object.values(single).every((a) => a.provider.name === "cerebras"),
  );

  process.env.GROQ_API_KEY = "gsk-test-fake";
  const both = resolveRoster({
    cerebras: byProvider.cerebras,
    groq: byProvider.groq,
  });
  const models = new Set(Object.values(both).map((a) => a.model));
  check("five roles -> five distinct models", models.size === 5, [...models].join(", "));
  check(
    "advocates come from different families",
    both.prosecution.model !== both.defense.model,
    `${both.prosecution.model} vs ${both.defense.model}`,
  );
  check("judge is flagged as a reasoning model", both.judge.isReasoning, both.judge.model);

  // Model IDs drift; a fully unknown catalog must degrade, not throw.
  const drifted = resolveRoster({ cerebras: new Set(["some-brand-new-model"]) });
  check("survives a fully unknown catalog", Object.keys(drifted).length === 5);

  // Failover: free tiers answer concurrent bursts with 429, and losing the
  // Defense costs the adversarial premise the whole project rests on.
  const cands = resolveCandidates({
    cerebras: byProvider.cerebras,
    groq: byProvider.groq,
  });
  check(
    "every role has a failover candidate",
    Object.values(cands).every((list) => list.length >= 2),
    JSON.stringify(Object.fromEntries(Object.entries(cands).map(([k, v]) => [k, v.length]))),
  );
  check(
    "first candidate is the primary assignment",
    cands.defense[0].model === both.defense.model,
  );
  check(
    "defense can fail over to another provider",
    cands.defense.some((a) => a.provider.name !== cands.defense[0].provider.name),
    cands.defense.map((a) => `${a.provider.name}/${a.model}`).join(" -> "),
  );
  check(
    "candidate lists contain no duplicates",
    Object.values(cands).every(
      (list) => new Set(list.map((a) => `${a.provider.name}/${a.model}`)).size === list.length,
    ),
  );

  delete process.env.CEREBRAS_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    resolveRoster(null);
    check("throws with no keys", false, "should have thrown");
  } catch (e) {
    check("throws with no keys", e instanceof NoProviderError);
  }
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// --- 4. Citations -----------------------------------------------------------

section("[4] Citation classification — what CrossRef can actually check");
const classifications: [string, string][] = [
  ["Smith, L. M., et al., 'Visual Resolution Limits for Low-Earth-Orbit Observers,' Journal of Applied Optics (2010)", "check"],
  ["Orben, J., & Przybylski, A. K.", "check"],
  ["Keles, B., McCrae, N., & Grealish, A.", "check"],
  ["Twenge, J. M., et al.", "check"],
  ["Madsen KM et al., \"Thimerosal and the occurrence of autism\"", "check"],
  ["Lewis (2014)", "check"],
  ["see doi:10.1038/s41562-018-0506-1", "check"],
  // Venue names identify no work; checking them returns editorials.
  ["The Lancet Child & Adolescent Health", JOURNAL_ONLY],
  ["Journal of Adolescence", JOURNAL_ONLY],
  ["NASA Earth Observatory", INSTITUTIONAL],
  ["World Health Organization fact sheet", INSTITUTIONAL],
  // Hand-waving prose is not a citation and must never be accused.
  ["Official statements and reports from these organizations, as well as peer-reviewed literature spanning two decades", INSTITUTIONAL],
  ["unspecified", UNSOURCED],
  ["", UNSOURCED],
  ["n/a", UNSOURCED],
];
for (const [src, want] of classifications) {
  const got = classify(src);
  check(`classify ${JSON.stringify(src.slice(0, 40))} -> ${want}`, got === want, `got ${got}`);
}

check(
  "surnames from an author list",
  [...surnames("Keles, B., McCrae, N., & Grealish, A.")].sort().join(",") ===
    "grealish,keles,mccrae",
  [...surnames("Keles, B., McCrae, N., & Grealish, A.")].join(","),
);
check("surnames from the 'Lewis (2014)' form", surnames("Lewis (2014)").has("lewis"));
check("filler words are not surnames", !surnames("The Stressors (2020)").has("the"));
check(
  "doi extracted",
  doiIn("Lewis (2014) doi:10.64628/ab.749j9uquy") === "10.64628/ab.749j9uquy",
  doiIn("Lewis (2014) doi:10.64628/ab.749j9uquy"),
);
check("no false doi in plain prose", doiIn("NASA Earth Observatory 2005") === "");

section("[4b] Similarity — thresholds depend on this behaving sanely");
check("identical strings score 1", similar("a systematic review", "A Systematic Review") === 1);
check("unrelated strings score low", similar("vaccines and autism", "coral reef bleaching") < 0.5,
  String(similar("vaccines and autism", "coral reef bleaching")));
check(
  "near-identical titles score high",
  similar(
    "A systematic review: the influence of social media on depression",
    "A systematic review: the influence of social media on depression, anxiety and distress",
  ) > 0.75,
);
check("empty input scores 0", similar("", "anything") === 0);

section("[4c] Source collection");
const briefs = {
  prosecution: {
    evidence: [
      { source: "NASA Earth Observatory", point: "p" },
      { source: "unspecified", point: "q" },
    ],
  },
  defense: { evidence: [{ source: "NASA Earth Observatory", point: "r" }] },
  expert: { key_findings: [{ source: "Nature, 2019", finding: "f" }] },
};
const found = collectSources(briefs);
check("sources deduplicated across parties", found.length === 3, JSON.stringify(found));
check(
  "party attribution kept",
  new Set(found.map(([, p]) => p)).size === 2,
  JSON.stringify(found.map(([, p]) => p)),
);
check("supporting claim text carried", found.some(([, , pt]) => pt === "p"));

// --- 5. Grounding -----------------------------------------------------------

section("[5] Grounding relevance — CrossRef returns book-chapter noise");
const wall = contentWords("The Great Wall of China is visible from space");
const relevanceCases: [string, boolean][] = [
  ["China", false],
  ["Introduction", false],
  ["Conclusions", false],
  ["Management in Transitional Economies", false],
  ["Is China's Great Wall visible from space?", true],
  ["Visual resolution limits for observers in space viewing the Great Wall", true],
];
for (const [title, want] of relevanceCases) {
  check(`relevance: ${title.slice(0, 44)} -> ${want}`, relevant(wall, title) === want);
}
check("stopwords excluded", !wall.has("the") && !wall.has("from"), [...wall].join(","));
check(
  "duckduckgo redirector unwrapped",
  unwrap("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x") ===
    "https://example.com/a",
  unwrap("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x"),
);
check("plain urls pass through", unwrap("https://plain.com/x") === "https://plain.com/x");

// --- summary ----------------------------------------------------------------

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
