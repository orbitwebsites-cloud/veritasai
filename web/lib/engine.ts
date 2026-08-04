/** The trial itself: retrieve, decompose, hear three parties, then rule. */

import * as cfg from "./config";
import * as citations from "./citations";
import * as grounding from "./grounding";
import * as prompts from "./prompts";
import {
  asList,
  asStringList,
  coerceInt,
  extractJson,
  JSONRecoveryError,
  repairPrompt,
} from "./jsonio";
import { buildCatalog, chat, ProviderError, type ChatMessage } from "./providers";
import type {
  AdvocateBrief,
  Docket,
  Evidence,
  ExpertBrief,
  NodeRecord,
  Role,
  StageState,
  Trial,
  Verdict,
  VerdictLabel,
} from "./types";

export type Progress = (role: Role, state: StageState) => void;

const VERDICT_LABELS: VerdictLabel[] = [
  "TRUE", "MOSTLY TRUE", "MIXED", "MOSTLY FALSE", "FALSE",
];
const CONFIDENCE_LABELS = ["High", "Moderate", "Low"];

interface NodeResult extends NodeRecord {
  data: Record<string, unknown> | null;
}

/**
 * One call plus up to MAX_REPAIRS re-asks if the JSON comes back malformed.
 *
 * A node never throws. A dead node returns ok=false and the trial proceeds
 * without it — the Judge is told which parties failed to appear and lowers its
 * confidence accordingly.
 */
async function runNode(
  candidates: cfg.Assignment[],
  system: string,
  user: string,
  schema: unknown,
  maxTokens: number,
  progress?: Progress,
): Promise<NodeResult> {
  const role = candidates[0].role;
  const result: NodeResult = {
    role,
    model: candidates[0].model,
    provider: candidates[0].provider.name,
    ok: false,
    error: null,
    latency_s: 0,
    repairs: 0,
    data: null,
  };
  const started = Date.now();
  const finish = () => {
    result.latency_s = Number(((Date.now() - started) / 1000).toFixed(2));
    return result;
  };
  progress?.(role, "running");

  const failures: string[] = [];

  // Walk the candidate list on *provider* failure (429, timeout, dead model).
  // A malformed-JSON failure is the model's problem, not the provider's, so
  // that path stays on the same model and uses the repair loop instead.
  for (const assignment of candidates) {
    result.model = assignment.model;
    result.provider = assignment.provider.name;

    // Reasoning models spend a large share of their budget inside <think>
    // before writing a single character of JSON. Giving them the same budget as
    // a non-reasoning model is how you get a truncated thought and no payload.
    const budget = assignment.isReasoning ? Math.floor(maxTokens * 2.5) : maxTokens;

    let history: ChatMessage[] = [{ role: "user", content: user }];
    let parseError = "";
    let providerFailed = false;

    for (let attempt = 0; attempt <= cfg.MAX_REPAIRS; attempt++) {
      let raw: string;
      try {
        raw = await chat(assignment, system, history, budget);
      } catch (err) {
        failures.push(err instanceof ProviderError ? err.message : String(err));
        providerFailed = true;
        break;
      }

      try {
        result.data = extractJson(raw);
        result.ok = true;
        result.error = null;
        result.repairs = attempt;
        progress?.(role, "done");
        return finish();
      } catch (err) {
        parseError = err instanceof JSONRecoveryError ? err.message : String(err);
        if (attempt === cfg.MAX_REPAIRS) break;
        progress?.(role, "repairing");
        // Keep the original task in view; append the bad turn and correct it.
        // An empty assistant turn is rejected by some providers, so a
        // truncated-to-nothing response gets a placeholder.
        history = [
          history[0],
          { role: "assistant", content: raw.slice(0, 2000) || "[no output produced]" },
          { role: "user", content: repairPrompt(schema, parseError) },
        ];
      }
    }

    if (!providerFailed) {
      result.repairs = cfg.MAX_REPAIRS;
      result.error = `unparseable JSON after ${cfg.MAX_REPAIRS} repair attempts (${parseError})`;
      progress?.(role, "failed");
      return finish();
    }
    // Provider failed: fall through to the next candidate, ideally on a
    // different provider.
  }

  result.error = failures.join(" | ").slice(0, 400) || "all candidate models failed";
  progress?.(role, "failed");
  return finish();
}

// --- Normalization ----------------------------------------------------------
// Open-weight models honor a schema loosely. Rather than reject a good argument
// over a wrong key name, coerce each payload into the shape the UI expects.

function get(d: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!d) return undefined;
  for (const k of keys) if (d[k] !== undefined && d[k] !== null) return d[k];
  return undefined;
}

function normDocket(data: Record<string, unknown> | null, claim: string): Docket {
  const fallback: Docket = {
    domain: "other",
    claim_type: "factual",
    sub_claims: [{ id: "S1", text: claim, why_it_matters: "" }],
    ambiguities: [],
  };
  if (!data) return fallback;

  const raw = asList(get(data, "sub_claims", "subclaims", "claims"));
  const subs = raw
    .map((s, i): { id: string; text: string; why_it_matters: string } => {
      if (typeof s === "string") return { id: `S${i + 1}`, text: s, why_it_matters: "" };
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? `S${i + 1}`),
        text: String(o.text ?? o.claim ?? o.sub_claim ?? ""),
        why_it_matters: String(o.why_it_matters ?? o.relevance ?? ""),
      };
    })
    .filter((s) => s.text);

  return {
    domain: String(get(data, "domain") ?? "other"),
    claim_type: String(get(data, "claim_type", "type") ?? "factual"),
    sub_claims: subs.length ? subs : fallback.sub_claims,
    ambiguities: asStringList(get(data, "ambiguities", "ambiguous_terms")),
  };
}

function normEvidence(items: unknown): Evidence[] {
  return asList(items)
    .map((e): Evidence => {
      if (typeof e === "string") {
        return { point: e, source: "unspecified", strength: "weak" };
      }
      const o = (e ?? {}) as Record<string, unknown>;
      const st = String(o.strength ?? "moderate").toLowerCase();
      return {
        point: String(o.point ?? o.evidence ?? o.claim ?? ""),
        source: String(o.source ?? o.citation ?? "unspecified"),
        strength: (["strong", "moderate", "weak"].includes(st)
          ? st
          : "moderate") as Evidence["strength"],
      };
    })
    .filter((e) => e.point);
}

function normAdvocate(data: Record<string, unknown> | null): AdvocateBrief | null {
  if (!data) return null;
  return {
    confidence: coerceInt(get(data, "confidence", "confidence_score")),
    headline: String(get(data, "headline", "position", "summary") ?? ""),
    evidence: normEvidence(get(data, "evidence", "arguments", "points")),
    fallacies: asStringList(get(data, "fallacies", "logical_fallacies")),
    concessions: asStringList(get(data, "concessions", "concessions_to_other_side")),
  };
}

function normExpert(data: Record<string, unknown> | null): ExpertBrief | null {
  if (!data) return null;
  const findings = asList(get(data, "key_findings", "findings"))
    .map((f) => {
      if (typeof f === "string") {
        return { finding: f, source: "unspecified", year: "unknown" };
      }
      const o = (f ?? {}) as Record<string, unknown>;
      return {
        finding: String(o.finding ?? o.point ?? ""),
        source: String(o.source ?? "unspecified"),
        year: String(o.year ?? "unknown"),
      };
    })
    .filter((f) => f.finding);

  return {
    certainty: coerceInt(get(data, "certainty", "confidence")),
    consensus: String(get(data, "consensus", "expert_consensus") ?? ""),
    key_findings: findings,
    open_questions: asStringList(get(data, "open_questions")),
    common_misreadings: asStringList(get(data, "common_misreadings", "misconceptions")),
  };
}

const BANDS: [number, VerdictLabel][] = [
  [15, "FALSE"], [39, "MOSTLY FALSE"], [60, "MIXED"], [84, "MOSTLY TRUE"], [100, "TRUE"],
];
const RANGES: Record<VerdictLabel, [number, number]> = {
  FALSE: [0, 15],
  "MOSTLY FALSE": [16, 39],
  MIXED: [40, 60],
  "MOSTLY TRUE": [61, 84],
  TRUE: [85, 100],
};

function labelFor(score: number): VerdictLabel {
  return BANDS.find(([ceil]) => score <= ceil)![1];
}

function normVerdict(
  data: Record<string, unknown> | null,
  proConf: number,
  defConf: number,
): Omit<Verdict, "briefs" | "grounding" | "citations"> {
  let payload = data;
  if (!payload) {
    // No ruling: fall back to the advocates' own numbers so the user still gets
    // a calibrated answer instead of an error page.
    const score = Math.max(0, Math.min(100, Math.floor((defConf + (100 - proConf)) / 2)));
    payload = {
      verdict: labelFor(score),
      truth_score: score,
      confidence: "Low",
      reasoning:
        "The Judge failed to return a ruling. This score is derived from the " +
        "Prosecution and Defense confidence scores alone and should be treated " +
        "as provisional.",
    };
  }

  let score = coerceInt(get(payload, "truth_score", "score"));
  let label = String(get(payload, "verdict", "label") ?? "").trim().toUpperCase();
  if (!VERDICT_LABELS.includes(label as VerdictLabel)) {
    label = labelFor(score);
  } else if (labelFor(score) !== label) {
    // The model picked a label its own score contradicts. The prose label is
    // the more considered judgment, so snap the score into that band.
    const [lo, hi] = RANGES[label as VerdictLabel];
    score = Math.max(lo, Math.min(hi, score));
  }

  let conf = String(get(payload, "confidence") ?? "Moderate").trim();
  conf = conf.charAt(0).toUpperCase() + conf.slice(1).toLowerCase();
  if (!CONFIDENCE_LABELS.includes(conf)) conf = "Moderate";

  return {
    verdict: label as VerdictLabel,
    truth_score: score,
    confidence: conf as Verdict["confidence"],
    reasoning: String(get(payload, "reasoning", "explanation") ?? ""),
    strongest_for: String(get(payload, "strongest_for", "strongest_argument_for") ?? ""),
    strongest_against: String(
      get(payload, "strongest_against", "strongest_argument_against") ?? "",
    ),
    nuances: asStringList(get(payload, "nuances", "caveats")),
    recommended_reading: asStringList(
      get(payload, "recommended_reading", "further_reading"),
    ),
  };
}

// --- Orchestration ----------------------------------------------------------

let cachedRoster: Record<Role, cfg.Assignment> | null = null;
let cachedCandidates: Record<Role, cfg.Assignment[]> | null = null;

/** Verify model IDs against the live catalog, then assign roles. Cached. */
export async function resolve(): Promise<Record<Role, cfg.Assignment>> {
  if (cachedRoster) return cachedRoster;
  const catalog = await buildCatalog();
  cachedRoster = cfg.resolveRoster(catalog);
  cachedCandidates = cfg.resolveCandidates(catalog);
  return cachedRoster;
}

/** Ordered failover list per role — see resolveCandidates for why. */
async function candidates(): Promise<Record<Role, cfg.Assignment[]>> {
  if (!cachedCandidates) await resolve();
  return cachedCandidates!;
}

export interface TrialOptions {
  ground?: boolean;
  verifyCitations?: boolean;
  progress?: Progress;
}

export async function tryClaim(claim: string, opts: TrialOptions = {}): Promise<Trial> {
  const { ground = true, verifyCitations = true, progress } = opts;
  claim = claim.trim();
  if (!claim) throw new Error("claim is empty");

  const roster = await candidates();
  const nodes: NodeRecord[] = [];
  const started = Date.now();

  // Retrieval and decomposition both need only the claim, so the web search
  // runs concurrently with the docket and is effectively free.
  const groundTask = (async () => {
    if (!ground) return null;
    progress?.("grounding", "running");
    const res = await grounding.ground(20_000, claim);
    progress?.("grounding", res.ok ? "done" : "failed");
    return res;
  })();

  const clerkTask = runNode(
    roster.decomposer,
    prompts.DECOMPOSER_SYSTEM,
    prompts.decomposerUser(claim),
    prompts.DECOMPOSER_SCHEMA,
    cfg.MAX_TOKENS,
    progress,
  );

  const [search, clerk] = await Promise.all([groundTask, clerkTask]);

  if (search) {
    nodes.push({
      role: "grounding",
      model: "crossref+wikipedia+duckduckgo",
      provider: "direct",
      ok: search.ok,
      error: search.error,
      latency_s: search.latency_s,
      repairs: 0,
    });
  }
  nodes.push(strip(clerk));

  const docket = normDocket(clerk.data, claim);
  const context = grounding.asContext(search?.data ?? null);

  // Three independent parties. Nothing about the Prosecution's brief informs
  // the Defense's, so running them serially would be pure latency.
  const [pro, exp, dfn] = await Promise.all([
    runNode(roster.prosecution, prompts.PROSECUTION_SYSTEM,
      prompts.prosecutionUser(claim, docket, context),
      prompts.ADVOCATE_SCHEMA, cfg.MAX_TOKENS, progress),
    runNode(roster.expert, prompts.EXPERT_SYSTEM,
      prompts.expertUser(claim, docket, context),
      prompts.EXPERT_SCHEMA, cfg.MAX_TOKENS, progress),
    runNode(roster.defense, prompts.DEFENSE_SYSTEM,
      prompts.defenseUser(claim, docket, context),
      prompts.ADVOCATE_SCHEMA, cfg.MAX_TOKENS, progress),
  ]);
  nodes.push(strip(pro), strip(exp), strip(dfn));

  const prosecution = normAdvocate(pro.data);
  const expert = normExpert(exp.data);
  const defense = normAdvocate(dfn.data);
  const briefs = { docket, prosecution, expert, defense };

  // The ruling and the citation audit are independent: the verifier reads the
  // filed briefs, not the verdict. Run them together.
  const judgeTask = runNode(
    roster.judge,
    prompts.JUDGE_SYSTEM,
    prompts.judgeUser(claim, docket, prosecution, expert, defense, context),
    prompts.JUDGE_SCHEMA,
    cfg.JUDGE_MAX_TOKENS,
    progress,
  );

  const citeTask = (async () => {
    if (!verifyCitations) return null;
    progress?.("citations", "running");
    try {
      const report = await citations.verifyBriefs(briefs);
      progress?.("citations", "done");
      return report;
    } catch (err) {
      progress?.("citations", "failed");
      return {
        checks: [], summary: {}, flagged: 0, checked: 0, unchecked: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  const [judge, citationReport] = await Promise.all([judgeTask, citeTask]);
  nodes.push(strip(judge));

  const core = normVerdict(
    judge.data,
    prosecution?.confidence ?? 50,
    defense?.confidence ?? 50,
  );

  return {
    claim,
    nodes,
    total_s: Number(((Date.now() - started) / 1000).toFixed(2)),
    verdict: {
      ...core,
      briefs,
      grounding: search?.ok && search.data
        ? { ...search.data, model: "crossref+wikipedia+duckduckgo" }
        : null,
      citations: citationReport,
    },
  };
}

function strip(n: NodeResult): NodeRecord {
  const { data: _data, ...rest } = n;
  return rest;
}
