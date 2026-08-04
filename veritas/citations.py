"""Citation verification against CrossRef.

The prompts forbid fabricating sources. Nothing enforced that, which was the
largest honest gap in the system: an advocate could invent a plausible paper and
the Judge would weigh it as evidence. This module closes it.

Every source string an advocate cites is classified, and the academic-looking
ones are checked against CrossRef's live index of ~150M scholarly works. A paper
that does not exist does not match, and gets flagged in the verdict.

Verdicts assigned to each source:
  verified      a CrossRef record matched closely; DOI attached
  partial       something similar exists, but the citation is loose or garbled
  unverified    looks like a journal article, and CrossRef has no such record
  institutional a body like NASA or WHO — real, but not a CrossRef work, so
                absence of a match proves nothing and we do not imply otherwise
  unsourced     the advocate cited nothing checkable

`unverified` is the interesting one: it is the fabrication signal.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, asdict
from difflib import SequenceMatcher
from typing import Any

CROSSREF = "https://api.crossref.org/works"
# CrossRef routes requests that identify a contact into its "polite pool",
# which is materially less throttled than the anonymous one.
MAILTO = "veritasai-research@example.com"
UA = f"VeritasAI/1.0 (adversarial fact-checking research; mailto:{MAILTO})"

VERIFIED, PARTIAL, UNVERIFIED, INSTITUTIONAL, UNSOURCED, JOURNAL_ONLY, UNCHECKED = (
    "verified", "partial", "unverified", "institutional", "unsourced",
    "journal_only", "unchecked",
)

STATUS_ORDER = [UNVERIFIED, PARTIAL, VERIFIED, UNCHECKED, JOURNAL_ONLY, INSTITUTIONAL, UNSOURCED]

# Bodies that publish real material outside the journal system. A CrossRef miss
# on one of these is meaningless, so they must never be reported as suspect.
_INSTITUTIONS = (
    "nasa", "esa", "who", "world health", "cdc", "nih", "noaa", "usgs", "fda",
    "epa", "european space", "national geographic", "smithsonian", "unicef",
    "united nations", "world bank", "oecd", "eurostat", "census bureau",
    "pew research", "gallup", "earth observatory", "met office", "ipcc",
    "national academies", "royal society", "mayo clinic", "cleveland clinic",
    "johns hopkins", "harvard health", "administration", "ministry",
    "department of", "bureau of", "agency", "iaea", "wikipedia", "britannica",
)

# Signals that a citation is claiming to be a peer-reviewed work, which is what
# makes it checkable — and what makes a miss meaningful.
_ACADEMIC = (
    "et al", "journal", "proceedings", "doi", "vol.", "volume", "pp.",
    "nature", "science,", "lancet", "bmj", "jama", "plos", "arxiv", "review of",
    "quarterly", "annals", "bulletin", "transactions", "psychological",
)

_QUOTED = re.compile(r"[\"'“‘]([^\"'”’]{12,240})[\"'”’]")
_YEAR = re.compile(r"\b(1[89]\d{2}|20[0-4]\d)\b")
# "Orben, J.", "Keles, B., McCrae, N.", "Smith, L. M." — an author list is the
# strongest signal that a specific work is being cited, with or without a year.
# Internal capitals and punctuation are normal in surnames (McCrae, O'Brien,
# Lopez-Gil), so the pattern must not assume all-lowercase after the first char.
_AUTHOR = re.compile(
    r"\b([A-Z][a-zA-Z'’\-]{2,})\s*(?:,\s*[A-Z]\.|\s+[A-Z]{1,3}\b(?!\w))"
)
_ETAL = re.compile(r"\bet\s+al\b", re.I)
# "Lewis (2014)", "Hoy (2011)" — a surname with a bare year, no initials.
_SURNAME_YEAR = re.compile(r"\b([A-Z][a-zA-Z'’\-]{2,})\s*[,(]\s*((?:19|20)\d{2})\)?")
# A DOI is the strongest possible signal: it either resolves or it does not.
_DOI = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)", re.I)
_NOISE = re.compile(r"\b(unspecified|unknown|n/?a|none|various|multiple sources)\b", re.I)

# A bare journal or venue name is not a citation of anything. Sending it to
# CrossRef returns editorials and masthead notices that match on title words —
# which is exactly the false "partial match" this guard exists to prevent.
_VENUE_ONLY = re.compile(
    r"^(the\s+)?[\w&'’\-\s\.]{4,60}"
    r"(journal|review|proceedings|annals|bulletin|transactions|quarterly|letters|"
    r"lancet|nature|science|jama|bmj|plos|psychological science|health)"
    r"[\w&'’\-\s\.]{0,40}$",
    re.I,
)


_NOT_A_SURNAME = {"the", "and", "vol", "pp", "doi", "journal", "review", "report", "study"}


def surnames(source: str) -> set[str]:
    """Author surnames, from either 'Smith, J.' or 'Smith (2014)' forms."""
    found = {m.group(1).lower() for m in _AUTHOR.finditer(source or "")}
    found |= {m.group(1).lower() for m in _SURNAME_YEAR.finditer(source or "")}
    return found - _NOT_A_SURNAME


def doi_in(source: str) -> str:
    m = _DOI.search(source or "")
    return m.group(1).rstrip(".,;)") if m else ""


@dataclass
class SourceCheck:
    source: str
    party: str
    status: str
    detail: str = ""
    matched_title: str = ""
    doi: str = ""
    similarity: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def classify(source: str) -> str:
    """Decide whether a source string names a *specific work* CrossRef can check.

    The distinction that matters is not academic-vs-institutional, it is
    "does this identify one work?" An author list does. A journal name does
    not, and checking one produces confident nonsense.
    """
    s = (source or "").strip()
    if len(s) < 6 or _NOISE.fullmatch(s.strip(" .")) or _NOISE.match(s):
        return UNSOURCED

    low = s.lower()
    if doi_in(s):
        return "check"
    has_authors = bool(surnames(s)) or bool(_ETAL.search(s))
    has_title = bool(_QUOTED.search(s))
    institutional = any(k in low for k in _INSTITUTIONS)

    # Hand-waving prose ("official statements and reports from these
    # organizations, as well as peer-reviewed literature") names no work.
    # Sending it to CrossRef produces a confident-looking accusation about
    # something that was never a citation.
    if not has_title and not has_authors and len(s.split()) > 10:
        return INSTITUTIONAL

    # An identifiable work: named authors, or a quoted title. This is what a
    # model fabricates, and the only thing worth a lookup.
    if has_authors or has_title:
        return "check"

    # Institutions are checked before venues: "World Health Organization fact
    # sheet" ends in a word the venue pattern claims, and misfiling it as a
    # journal would be wrong in a way users would notice.
    if institutional:
        return INSTITUTIONAL

    # A venue with no work attached — real, but it identifies nothing.
    if _VENUE_ONLY.match(s) or any(k in low for k in _ACADEMIC):
        return JOURNAL_ONLY

    return INSTITUTIONAL


def _query_text(source: str) -> str:
    """Prefer a quoted title — it is the highest-signal part of a citation."""
    m = _QUOTED.search(source)
    title = m.group(1) if m else source
    return re.sub(r"\s+", " ", title).strip()[:300]


async def _crossref_query(client, query: str, authors: str = "", attempts: int = 3) -> tuple[list[dict], str]:
    """Query CrossRef with backoff. Returns (items, error) — never raises.

    CrossRef throttles bursts, and a throttled lookup previously came back
    indistinguishable from "nothing to check here". It must be distinguishable.
    """
    delay = 0.6
    last = ""
    params = {"query.bibliographic": query, "rows": 8, "mailto": MAILTO,
              "select": "title,DOI,issued,container-title,author"}
    # Constraining by author is what makes a real paper findable from a loose
    # title. Without it, "A systematic review of social media" returns a
    # thousand unrelated reviews and the true record never surfaces.
    if authors:
        params["query.author"] = authors

    for attempt in range(attempts):
        try:
            resp = await client.get(CROSSREF, params=params, headers={"User-Agent": UA})
            if resp.status_code in (429, 500, 502, 503, 504):
                last = f"HTTP {resp.status_code}"
                if attempt < attempts - 1:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                return [], last
            resp.raise_for_status()
            return resp.json().get("message", {}).get("items", []), ""
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            last = type(exc).__name__
            if attempt < attempts - 1:
                await asyncio.sleep(delay)
                delay *= 2
    return [], last


def _record_surnames(item: dict) -> set[str]:
    return {
        (a.get("family") or "").lower()
        for a in (item.get("author") or [])
        if a.get("family")
    }


def _record_year(item: dict) -> str:
    parts = (item.get("issued") or {}).get("date-parts") or [[]]
    return str(parts[0][0]) if parts and parts[0] else ""


async def _resolve_doi(client, doi: str) -> tuple[dict | None, str]:
    """Look a DOI up directly. Returns (record, error); record is None if absent."""
    for attempt in range(3):
        try:
            resp = await client.get(
                f"{CROSSREF}/{doi}",
                params={"mailto": MAILTO},
                headers={"User-Agent": UA},
            )
            if resp.status_code == 404:
                return None, ""
            if resp.status_code in (429, 500, 502, 503, 504):
                if attempt < 2:
                    await asyncio.sleep(0.6 * (attempt + 1))
                    continue
                return None, f"HTTP {resp.status_code}"
            resp.raise_for_status()
            return resp.json().get("message", {}), ""
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            if attempt == 2:
                return None, type(exc).__name__
            await asyncio.sleep(0.6 * (attempt + 1))
    return None, "unreachable"


async def _check_one(client, source: str, party: str, point: str, sem: asyncio.Semaphore) -> SourceCheck:
    kind = classify(source)
    if kind != "check":
        detail = {
            UNSOURCED: "No checkable source was named.",
            JOURNAL_ONLY: "Names a journal or venue but not a specific work — nothing to look up.",
            INSTITUTIONAL: "Institutional or non-journal source — outside CrossRef's index, so it was not checked.",
        }[kind]
        return SourceCheck(source=source, party=party, status=kind, detail=detail)

    # A cited DOI is decisive in both directions: it resolves to exactly one
    # work, or it does not exist. Nothing else in this module is this certain,
    # and a fabricated DOI is a common and very confident-looking hallucination.
    doi = doi_in(source)
    if doi:
        async with sem:
            record, err = await _resolve_doi(client, doi)
        if err:
            return SourceCheck(
                source=source, party=party, status=UNCHECKED, doi=doi,
                detail=f"CrossRef could not be reached ({err}) — this DOI was NOT verified.",
            )
        if record is None:
            return SourceCheck(
                source=source, party=party, status=UNVERIFIED, doi=doi,
                detail=f"The cited DOI {doi} does not resolve to any registered work.",
            )
        return SourceCheck(
            source=source, party=party, status=VERIFIED, doi=doi, similarity=1.0,
            matched_title=(record.get("title") or [""])[0],
            detail="The cited DOI resolves to a registered work.",
        )

    quoted = _QUOTED.search(source)
    title_query = _query_text(source)
    cited_names = surnames(source)
    cited_year = (_YEAR.search(source) or [None])
    cited_year = cited_year.group(0) if hasattr(cited_year, "group") else ""

    # With no quoted title, the source is just an author list — too thin to
    # match on alone. The evidence text describes the finding, which is exactly
    # what CrossRef's bibliographic index is good at.
    query = title_query if quoted else f"{title_query} {point}".strip()[:350]

    async with sem:
        items, error = await _crossref_query(client, query, " ".join(sorted(cited_names)))

    if error:
        # A lookup that never happened is not evidence of anything. Reporting it
        # as "institutional" would let a fabricated citation pass as fine, which
        # is the exact failure this feature exists to prevent.
        return SourceCheck(
            source=source, party=party, status=UNCHECKED,
            detail=f"CrossRef could not be reached ({error}) — this citation was NOT verified.",
        )

    if not items:
        return SourceCheck(
            source=source, party=party, status=UNVERIFIED,
            detail="Cited as a specific work, but CrossRef returned no records for it.",
        )

    # When the citation names authors, authors decide it. Title similarity is a
    # fallback for title-only citations, and must never override a surname
    # miss: "systematic review of social media" matches dozens of unrelated
    # papers at 0.8+, which is how a wrong paper gets stamped verified.
    # Best title match overall, and best title match among records that also
    # share a cited surname. Common surnames (Taylor, Madsen) make author
    # overlap alone nearly meaningless — CrossRef will happily return a paper
    # by *some* Taylor about anything at all.
    best_any, best_any_sim = None, 0.0
    best_auth, best_auth_sim, best_auth_year = None, 0.0, False
    for item in items:
        title = (item.get("title") or [""])[0]
        sim = _similar(title_query, title)
        if sim > best_any_sim:
            best_any, best_any_sim = item, sim
        if cited_names and (cited_names & _record_surnames(item)) and sim > best_auth_sim:
            best_auth, best_auth_sim = item, sim
            best_auth_year = (not cited_year) or cited_year == _record_year(item)

    def hit(item, sim, status, detail) -> SourceCheck:
        return SourceCheck(
            source=source, party=party, status=status, detail=detail,
            matched_title=(item.get("title") or [""])[0], doi=item.get("DOI", ""),
            similarity=round(sim, 2),
        )

    if quoted:
        # A title was claimed, so the title has to hold up. Author agreement
        # only raises confidence in a match the title already supports.
        if best_auth is not None and best_auth_sim >= 0.62:
            return hit(best_auth, best_auth_sim,
                       VERIFIED if best_auth_year else PARTIAL,
                       "Author and title match a real CrossRef record." if best_auth_year
                       else "Author and title match a real record, but the year differs.")
        if best_any_sim >= 0.82:
            # The work is real. If authors were named and none of them appear on
            # it, the work exists but the attribution does not — a different
            # defect from fabrication, and worth saying precisely.
            if cited_names and best_auth is None:
                return hit(best_any, best_any_sim, PARTIAL,
                           "A work with this title exists, but CrossRef does not list any of "
                           "the cited authors on it — the attribution appears wrong.")
            return hit(best_any, best_any_sim, VERIFIED, "Title matches a CrossRef record.")
        if best_any_sim >= 0.60:
            return hit(best_any, best_any_sim, PARTIAL,
                       "A similar work exists; the citation may be imprecise or conflated.")
        if cited_names and best_auth is not None:
            # Real authors, but nothing of theirs carries this title. Report it
            # as unconfirmed, and show no match — displaying an unrelated paper
            # here is how this check produced nonsense like matching a vaccine
            # study to a paper on language learning.
            return SourceCheck(
                source=source, party=party, status=PARTIAL, similarity=round(best_auth_sim, 2),
                detail=("These authors publish in this area, but CrossRef has no work of "
                        "theirs under the cited title — the citation could not be confirmed."),
            )
        return SourceCheck(
            source=source, party=party, status=UNVERIFIED, similarity=round(best_any_sim, 2),
            detail="No CrossRef record matches this title or these authors. Treat as unsupported.",
        )

    # No title claimed — an author list alone identifies no specific work, so
    # the strongest honest statement is that the authors are real.
    if best_auth is not None:
        return hit(best_auth, best_auth_sim, PARTIAL,
                   "An author match exists in CrossRef, but the citation named no title, "
                   "so the specific work could not be confirmed.")
    return SourceCheck(
        source=source, party=party, status=UNVERIFIED, similarity=round(best_any_sim, 2),
        detail="No CrossRef record lists the cited authors. Treat as unsupported.",
    )


def collect_sources(briefs: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Pull every (source, party, claim_text) triple out of the filed briefs.

    The claim text travels with the source because an author-only citation is
    not searchable on its own — the finding it supports is what identifies the
    work in a bibliographic index.
    """
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()

    def add(src: str, party: str, point: str) -> None:
        s = (src or "").strip()
        key = _norm(s)
        if s and key and key not in seen:
            seen.add(key)
            out.append((s, party, (point or "").strip()))

    for party in ("prosecution", "defense"):
        payload = briefs.get(party)
        if payload:
            for e in payload.get("evidence", []):
                add(e.get("source", ""), party, e.get("point", ""))

    expert = briefs.get("expert")
    if expert:
        for f in expert.get("key_findings", []):
            add(f.get("source", ""), "expert", f.get("finding", ""))

    return out


async def verify_briefs(briefs: dict[str, Any], limit: int = 24) -> dict[str, Any]:
    """Check every cited source. Returns a report plus a per-party summary."""
    import httpx

    sources = collect_sources(briefs)[:limit]
    if not sources:
        return {"checks": [], "summary": {}, "flagged": 0, "checked": 0}

    # CrossRef throttles concurrent bursts; 2 in flight verifies a full docket
    # in a couple of seconds without tripping the limiter.
    sem = asyncio.Semaphore(2)
    async with httpx.AsyncClient(timeout=25, follow_redirects=True) as client:
        checks = await asyncio.gather(
            *(_check_one(client, s, p, point, sem) for s, p, point in sources)
        )

    summary: dict[str, dict[str, int]] = {}
    for c in checks:
        summary.setdefault(c.party, {}).setdefault(c.status, 0)
        summary[c.party][c.status] += 1

    return {
        "checks": [c.to_dict() for c in checks],
        "summary": summary,
        "flagged": sum(1 for c in checks if c.status == UNVERIFIED),
        "checked": sum(1 for c in checks if c.status in (VERIFIED, PARTIAL, UNVERIFIED)),
        "unchecked": sum(1 for c in checks if c.status == UNCHECKED),
    }
