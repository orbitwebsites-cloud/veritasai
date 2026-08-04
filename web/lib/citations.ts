/**
 * Citation verification against CrossRef.
 *
 * The prompts forbid fabricating sources. Nothing enforced that, which was the
 * largest honest gap in the system: an advocate could invent a plausible paper
 * and the Judge would weigh it as evidence. This module closes it.
 *
 * Two rules were earned through failure and must not be relaxed:
 *
 *   1. A lookup that did not happen is never a pass. The first version
 *      reported network errors as "institutional, not checked", so a fabricated
 *      citation sailed through whenever CrossRef rate-limited. `unchecked`
 *      exists to make that impossible.
 *
 *   2. Precision over recall. Falsely accusing a real paper of being fabricated
 *      is worse than missing a fake one. A common surname proves nothing —
 *      CrossRef will return a paper by *some* Taylor about anything at all — so
 *      an author match with an unrelated title reports "could not confirm" and
 *      shows no match, rather than stamping a verdict on the wrong paper.
 */

import type { CitationReport, SourceCheck } from "./types";

const CROSSREF = "https://api.crossref.org/works";
const MAILTO = "veritasai-research@example.com";
const UA = `VeritasAI/1.0 (adversarial fact-checking research; mailto:${MAILTO})`;

export const VERIFIED = "verified";
export const PARTIAL = "partial";
export const UNVERIFIED = "unverified";
export const UNCHECKED = "unchecked";
export const JOURNAL_ONLY = "journal_only";
export const INSTITUTIONAL = "institutional";
export const UNSOURCED = "unsourced";

export const STATUS_ORDER = [
  UNVERIFIED, PARTIAL, VERIFIED, UNCHECKED, JOURNAL_ONLY, INSTITUTIONAL, UNSOURCED,
];

// Bodies that publish real material outside the journal system. A CrossRef miss
// on one of these is meaningless, so they must never be reported as suspect.
const INSTITUTIONS = [
  "nasa", "esa", "who", "world health", "cdc", "nih", "noaa", "usgs", "fda",
  "epa", "european space", "national geographic", "smithsonian", "unicef",
  "united nations", "world bank", "oecd", "eurostat", "census bureau",
  "pew research", "gallup", "earth observatory", "met office", "ipcc",
  "national academies", "royal society", "mayo clinic", "cleveland clinic",
  "johns hopkins", "harvard health", "administration", "ministry",
  "department of", "bureau of", "agency", "iaea", "wikipedia", "britannica",
];

const ACADEMIC = [
  "et al", "journal", "proceedings", "doi", "vol.", "volume", "pp.",
  "nature", "science,", "lancet", "bmj", "jama", "plos", "arxiv", "review of",
  "quarterly", "annals", "bulletin", "transactions", "psychological",
];

const QUOTED = /["'“‘]([^"'”’]{12,240})["'”’]/;
const YEAR = /\b(1[89]\d{2}|20[0-4]\d)\b/;
// Internal capitals and punctuation are normal in surnames (McCrae, O'Brien),
// so the pattern must not assume all-lowercase after the first character.
const AUTHOR = /\b([A-Z][a-zA-Z'’-]{2,})\s*(?:,\s*[A-Z]\.|\s+[A-Z]{1,3}\b(?!\w))/g;
// "Lewis (2014)", "Hoy (2011)" — a surname with a bare year, no initials.
const SURNAME_YEAR = /\b([A-Z][a-zA-Z'’-]{2,})\s*[,(]\s*((?:19|20)\d{2})\)?/g;
const ETAL = /\bet\s+al\b/i;
// A DOI either resolves or it does not. Nothing else here is this certain.
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i;
const NOISE = /^\s*(unspecified|unknown|n\/?a|none|various|multiple sources)\b/i;

// A bare journal name is not a citation of anything. Sending it to CrossRef
// returns editorials and masthead notices that match on title words.
const VENUE_ONLY =
  /^(the\s+)?[\w&'’\-\s.]{4,60}(journal|review|proceedings|annals|bulletin|transactions|quarterly|letters|lancet|nature|science|jama|bmj|plos|psychological science|health)[\w&'’\-\s.]{0,40}$/i;

const NOT_A_SURNAME = new Set([
  "the", "and", "vol", "pp", "doi", "journal", "review", "report", "study",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Similarity in [0,1], via longest common subsequence over normalized text.
 *
 * Python's difflib.SequenceMatcher has no JS equivalent. LCS is close enough in
 * behaviour, but it scores slightly higher than difflib on partial overlaps, so
 * the thresholds below were re-tuned against the same benchmark of real vs.
 * fabricated citations rather than carried over from the Python version.
 */
export function similar(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Cap the work: citation strings are short, but a pathological input
  // shouldn't turn one lookup into a quadratic blowup.
  const A = x.slice(0, 400);
  const B = y.slice(0, 400);

  let prev = new Uint16Array(B.length + 1);
  let cur = new Uint16Array(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return (2 * prev[B.length]) / (A.length + B.length);
}

export function surnames(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of (source ?? "").matchAll(AUTHOR)) out.add(m[1].toLowerCase());
  for (const m of (source ?? "").matchAll(SURNAME_YEAR)) out.add(m[1].toLowerCase());
  for (const bad of NOT_A_SURNAME) out.delete(bad);
  return out;
}

export function doiIn(source: string): string {
  const m = DOI_RE.exec(source ?? "");
  return m ? m[1].replace(/[.,;)]+$/, "") : "";
}

/**
 * Decide whether a source string names a *specific work* CrossRef can check.
 * The distinction that matters is not academic-vs-institutional, it is "does
 * this identify one work?" An author list does. A journal name does not, and
 * checking one produces confident nonsense.
 */
export function classify(source: string): string {
  const s = (source ?? "").trim();
  if (s.length < 6 || NOISE.test(s)) return UNSOURCED;

  const low = s.toLowerCase();
  if (doiIn(s)) return "check";

  const hasAuthors = surnames(s).size > 0 || ETAL.test(s);
  const hasTitle = QUOTED.test(s);
  const institutional = INSTITUTIONS.some((k) => low.includes(k));

  // Hand-waving prose ("official statements and reports from these
  // organizations") names no work. Sending it to CrossRef produces a
  // confident-looking accusation about something that was never a citation.
  if (!hasTitle && !hasAuthors && s.split(/\s+/).length > 10) return INSTITUTIONAL;

  if (hasAuthors || hasTitle) return "check";

  // Institutions before venues: "World Health Organization fact sheet" ends in
  // a word the venue pattern claims, and misfiling it would be visibly wrong.
  if (institutional) return INSTITUTIONAL;
  if (VENUE_ONLY.test(s) || ACADEMIC.some((k) => low.includes(k))) return JOURNAL_ONLY;
  return INSTITUTIONAL;
}

function queryText(source: string): string {
  const m = QUOTED.exec(source);
  return (m ? m[1] : source).replace(/\s+/g, " ").trim().slice(0, 300);
}

interface CrossrefItem {
  title?: string[];
  DOI?: string;
  issued?: { "date-parts"?: number[][] };
  author?: { family?: string }[];
}

function recordSurnames(item: CrossrefItem): Set<string> {
  return new Set(
    (item.author ?? []).map((a) => (a.family ?? "").toLowerCase()).filter(Boolean),
  );
}

function recordYear(item: CrossrefItem): string {
  const parts = item.issued?.["date-parts"]?.[0];
  return parts?.[0] ? String(parts[0]) : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Query CrossRef with backoff. Returns items plus an error string, never throws. */
export async function crossrefQuery(
  query: string,
  authors = "",
  attempts = 3,
): Promise<{ items: CrossrefItem[]; error: string }> {
  let delay = 600;
  let last = "";
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "8",
    mailto: MAILTO,
    select: "title,DOI,issued,container-title,author",
  });
  // Constraining by author is what makes a real paper findable from a loose
  // title. Without it, "A systematic review of social media" returns a thousand
  // unrelated reviews and the true record never surfaces.
  if (authors) params.set("query.author", authors);

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${CROSSREF}?${params}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(25_000),
      });
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        last = `HTTP ${res.status}`;
        if (i < attempts - 1) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        return { items: [], error: last };
      }
      if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
      const data = (await res.json()) as { message?: { items?: CrossrefItem[] } };
      return { items: data.message?.items ?? [], error: "" };
    } catch (err) {
      last = err instanceof Error ? err.name : "Error";
      if (i < attempts - 1) {
        await sleep(delay);
        delay *= 2;
      }
    }
  }
  return { items: [], error: last || "unreachable" };
}

/** Look a DOI up directly. record === null means it does not exist. */
export async function resolveDoi(
  doi: string,
): Promise<{ record: CrossrefItem | null; error: string }> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(
        `${CROSSREF}/${encodeURIComponent(doi)}?mailto=${MAILTO}`,
        { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) },
      );
      if (res.status === 404) return { record: null, error: "" };
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        if (i < 2) {
          await sleep(600 * (i + 1));
          continue;
        }
        return { record: null, error: `HTTP ${res.status}` };
      }
      if (!res.ok) return { record: null, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { message?: CrossrefItem };
      return { record: data.message ?? null, error: "" };
    } catch (err) {
      if (i === 2) return { record: null, error: err instanceof Error ? err.name : "Error" };
      await sleep(600 * (i + 1));
    }
  }
  return { record: null, error: "unreachable" };
}

function mk(
  source: string,
  party: string,
  status: string,
  detail: string,
  extra: Partial<SourceCheck> = {},
): SourceCheck {
  return {
    source,
    party,
    status: status as SourceCheck["status"],
    detail,
    matched_title: "",
    doi: "",
    similarity: 0,
    ...extra,
  };
}

export async function checkOne(
  source: string,
  party: string,
  point: string,
): Promise<SourceCheck> {
  const kind = classify(source);
  if (kind !== "check") {
    const detail: Record<string, string> = {
      [UNSOURCED]: "No checkable source was named.",
      [JOURNAL_ONLY]:
        "Names a journal or venue but not a specific work — nothing to look up.",
      [INSTITUTIONAL]:
        "Institutional or non-journal source — outside CrossRef's index, so it was not checked.",
    };
    return mk(source, party, kind, detail[kind] ?? "Not checked.");
  }

  // A cited DOI is decisive in both directions, and a fabricated DOI is a
  // common and very confident-looking hallucination.
  const doi = doiIn(source);
  if (doi) {
    const { record, error } = await resolveDoi(doi);
    if (error) {
      return mk(source, party, UNCHECKED,
        `CrossRef could not be reached (${error}) — this DOI was NOT verified.`, { doi });
    }
    if (record === null) {
      return mk(source, party, UNVERIFIED,
        `The cited DOI ${doi} does not resolve to any registered work.`, { doi });
    }
    return mk(source, party, VERIFIED, "The cited DOI resolves to a registered work.", {
      doi,
      similarity: 1,
      matched_title: record.title?.[0] ?? "",
    });
  }

  const quoted = QUOTED.test(source);
  const titleQuery = queryText(source);
  const citedNames = surnames(source);
  const yearMatch = YEAR.exec(source);
  const citedYear = yearMatch ? yearMatch[0] : "";

  // With no quoted title the source is just an author list — too thin to match
  // on alone. The evidence text describes the finding, which is what CrossRef's
  // bibliographic index is good at.
  const query = quoted ? titleQuery : `${titleQuery} ${point}`.trim().slice(0, 350);
  const { items, error } = await crossrefQuery(query, [...citedNames].sort().join(" "));

  if (error) {
    return mk(source, party, UNCHECKED,
      `CrossRef could not be reached (${error}) — this citation was NOT verified.`);
  }
  if (!items.length) {
    return mk(source, party, UNVERIFIED,
      "Cited as a specific work, but CrossRef returned no records for it.");
  }

  // Best title match overall, and best among records sharing a cited surname.
  // Common surnames make author overlap alone nearly meaningless.
  let bestAny: CrossrefItem | null = null;
  let bestAnySim = 0;
  let bestAuth: CrossrefItem | null = null;
  let bestAuthSim = 0;
  let bestAuthYear = false;

  for (const item of items) {
    const title = item.title?.[0] ?? "";
    const sim = similar(titleQuery, title);
    if (sim > bestAnySim) {
      bestAny = item;
      bestAnySim = sim;
    }
    if (citedNames.size) {
      const recs = recordSurnames(item);
      let shares = false;
      for (const n of citedNames) if (recs.has(n)) shares = true;
      if (shares && sim > bestAuthSim) {
        bestAuth = item;
        bestAuthSim = sim;
        bestAuthYear = !citedYear || citedYear === recordYear(item);
      }
    }
  }

  const hit = (item: CrossrefItem, sim: number, status: string, detail: string) =>
    mk(source, party, status, detail, {
      matched_title: item.title?.[0] ?? "",
      doi: item.DOI ?? "",
      similarity: Number(sim.toFixed(2)),
    });

  if (quoted) {
    // A title was claimed, so the title has to hold up. Author agreement only
    // raises confidence in a match the title already supports.
    if (bestAuth && bestAuthSim >= 0.62) {
      return hit(bestAuth, bestAuthSim, bestAuthYear ? VERIFIED : PARTIAL,
        bestAuthYear
          ? "Author and title match a real CrossRef record."
          : "Author and title match a real record, but the year differs.");
    }
    if (bestAny && bestAnySim >= 0.82) {
      // The work is real. If authors were named and none appear on it, the work
      // exists but the attribution does not — a different defect from fabrication.
      if (citedNames.size && !bestAuth) {
        return hit(bestAny, bestAnySim, PARTIAL,
          "A work with this title exists, but CrossRef does not list any of the " +
            "cited authors on it — the attribution appears wrong.");
      }
      return hit(bestAny, bestAnySim, VERIFIED, "Title matches a CrossRef record.");
    }
    if (bestAny && bestAnySim >= 0.6) {
      return hit(bestAny, bestAnySim, PARTIAL,
        "A similar work exists; the citation may be imprecise or conflated.");
    }
    if (citedNames.size && bestAuth) {
      // Real authors, nothing of theirs under this title. Show no match —
      // displaying an unrelated paper here is how this check once matched a
      // vaccine study to a paper on language learning.
      return mk(source, party, PARTIAL,
        "These authors publish in this area, but CrossRef has no work of theirs " +
          "under the cited title — the citation could not be confirmed.",
        { similarity: Number(bestAuthSim.toFixed(2)) });
    }
    return mk(source, party, UNVERIFIED,
      "No CrossRef record matches this title or these authors. Treat as unsupported.",
      { similarity: Number(bestAnySim.toFixed(2)) });
  }

  // No title claimed — an author list alone identifies no specific work, so the
  // strongest honest statement is that the authors are real.
  if (bestAuth) {
    return hit(bestAuth, bestAuthSim, PARTIAL,
      "An author match exists in CrossRef, but the citation named no title, so " +
        "the specific work could not be confirmed.");
  }
  return mk(source, party, UNVERIFIED,
    "No CrossRef record lists the cited authors. Treat as unsupported.",
    { similarity: Number(bestAnySim.toFixed(2)) });
}

interface Briefs {
  prosecution?: { evidence?: { source?: string; point?: string }[] } | null;
  defense?: { evidence?: { source?: string; point?: string }[] } | null;
  expert?: { key_findings?: { source?: string; finding?: string }[] } | null;
}

/** Every (source, party, claimText) triple in the filed briefs, deduplicated. */
export function collectSources(briefs: Briefs): [string, string, string][] {
  const out: [string, string, string][] = [];
  const seen = new Set<string>();

  const add = (src: string, party: string, point: string) => {
    const s = (src ?? "").trim();
    const key = norm(s);
    if (s && key && !seen.has(key)) {
      seen.add(key);
      out.push([s, party, (point ?? "").trim()]);
    }
  };

  for (const party of ["prosecution", "defense"] as const) {
    for (const e of briefs[party]?.evidence ?? []) {
      add(e.source ?? "", party, e.point ?? "");
    }
  }
  for (const f of briefs.expert?.key_findings ?? []) {
    add(f.source ?? "", "expert", f.finding ?? "");
  }
  return out;
}

/** Run tasks with bounded concurrency — CrossRef throttles parallel bursts. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function verifyBriefs(briefs: Briefs, limit = 24): Promise<CitationReport> {
  const sources = collectSources(briefs).slice(0, limit);
  if (!sources.length) {
    return { checks: [], summary: {}, flagged: 0, checked: 0, unchecked: 0 };
  }

  const checks = await pool(sources, 2, ([s, p, point]) => checkOne(s, p, point));

  const summary: Record<string, Record<string, number>> = {};
  for (const c of checks) {
    summary[c.party] ??= {};
    summary[c.party][c.status] = (summary[c.party][c.status] ?? 0) + 1;
  }

  return {
    checks,
    summary,
    flagged: checks.filter((c) => c.status === UNVERIFIED).length,
    checked: checks.filter((c) =>
      [VERIFIED, PARTIAL, UNVERIFIED].includes(c.status),
    ).length,
    unchecked: checks.filter((c) => c.status === UNCHECKED).length,
  };
}
