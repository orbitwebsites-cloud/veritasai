import { STATUS_ORDER } from "@/lib/citations";
import type { CitationReport, CitationStatus } from "@/lib/types";

const MARK: Record<CitationStatus, { glyph: string; className: string }> = {
  verified: { glyph: "✓", className: "text-def" },
  partial: { glyph: "~", className: "text-gold" },
  unverified: { glyph: "✗", className: "text-pro font-bold" },
  unchecked: { glyph: "?", className: "text-[#b07fd0]" },
  journal_only: { glyph: "·", className: "text-faint" },
  institutional: { glyph: "·", className: "text-faint" },
  unsourced: { glyph: "·", className: "text-faint" },
};

export function CitationAudit({ report }: { report: CitationReport | null }) {
  if (!report?.checks.length) return null;

  const checks = [...report.checks].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  const { flagged, checked, unchecked } = report;

  let head: string;
  let accent: string;
  if (flagged) {
    head = `${flagged} of ${checked} checkable citations could not be found in CrossRef — treat those as unsupported`;
    accent = "var(--color-pro)";
  } else if (unchecked) {
    head = `${unchecked} citation${unchecked > 1 ? "s" : ""} could not be checked (CrossRef unreachable)`;
    accent = "var(--color-gold)";
  } else if (checked) {
    head = `All ${checked} checkable citations matched a real record`;
    accent = "var(--color-def)";
  } else {
    head = "No specific works were cited, so nothing was checkable";
    accent = "var(--color-line)";
  }

  return (
    <>
      <h2 className="mt-9 mb-3.5 font-serif text-[15px] uppercase tracking-[2.4px] text-muted">
        Citation audit
      </h2>
      <div
        className="rounded-lg border border-line border-l-[3px] bg-panel px-6 py-5"
        style={{ borderLeftColor: accent }}
      >
        <h3 className="mb-3.5 font-serif text-[15px]">{head}</h3>

        <ul>
          {checks.map((c, i) => {
            const m = MARK[c.status];
            return (
              <li
                key={i}
                className="flex gap-2.5 border-t border-[#1b1f27] py-2 text-[13.5px] first:border-t-0"
              >
                <span className={`w-4 shrink-0 font-mono ${m.className}`} aria-hidden>
                  {m.glyph}
                </span>
                <span className="w-11 shrink-0 pt-0.5 text-[11px] uppercase text-faint">
                  {c.party.slice(0, 4)}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {c.source}
                  <span className="mt-0.5 block text-[12px] text-faint">
                    {c.doi ? (
                      <>
                        → {c.matched_title} ·{" "}
                        <a
                          href={`https://doi.org/${c.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#9dc0e8] hover:underline"
                        >
                          doi:{c.doi}
                        </a>
                      </>
                    ) : (
                      c.detail
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
