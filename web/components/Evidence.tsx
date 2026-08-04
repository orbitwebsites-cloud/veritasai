import type { GroundingData } from "@/lib/types";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-3.5 mb-2 text-[11px] uppercase tracking-wider text-faint first:mt-0">
      {children}
    </h3>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#9dc0e8] hover:underline"
    >
      {children}
    </a>
  );
}

export function EvidenceRetrieved({ data }: { data: GroundingData | null }) {
  if (!data) return null;
  const { papers, encyclopedia, web, counts } = data;
  if (!papers.length && !encyclopedia.length && !web.length) return null;

  return (
    <>
      <h2 className="mt-9 mb-3.5 font-serif text-[15px] uppercase tracking-[2.4px] text-muted">
        Evidence retrieved before the briefs{" "}
        <span className="normal-case tracking-normal">
          ({counts.papers} papers · {counts.encyclopedia} encyclopedia · {counts.web} web)
        </span>
      </h2>

      <div className="rounded-lg border border-line bg-panel px-6 py-5">
        {papers.length > 0 && (
          <>
            <Eyebrow>Peer-reviewed literature · CrossRef</Eyebrow>
            {papers.map((p, i) => (
              <div key={i} className="mb-2.5 text-[14px]">
                <Link href={`https://doi.org/${p.doi}`}>{p.title}</Link>
                <div className="text-[12px] text-faint">
                  {[p.authors, p.year && `(${p.year})`, p.journal].filter(Boolean).join(" · ")}
                  {p.citations ? ` · cited by ${p.citations}` : ""}
                </div>
              </div>
            ))}
          </>
        )}

        {encyclopedia.length > 0 && (
          <>
            <Eyebrow>Encyclopedic · Wikipedia</Eyebrow>
            {encyclopedia.map((w, i) => (
              <div key={i} className="mb-2.5 text-[14px]">
                <Link href={w.url}>{w.title}</Link>
                <div className="text-[12px] text-faint">{w.snippet}</div>
              </div>
            ))}
          </>
        )}

        {web.length > 0 && (
          <>
            <Eyebrow>Current web coverage · DuckDuckGo</Eyebrow>
            {web.map((w, i) => (
              <div key={i} className="mb-2.5 text-[14px]">
                <Link href={w.url}>{w.title}</Link>
                {w.snippet && <div className="text-[12px] text-faint">{w.snippet}</div>}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
