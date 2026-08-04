import type { AdvocateBrief, Evidence, ExpertBrief } from "@/lib/types";

const STRENGTH_BAR: Record<Evidence["strength"], string> = {
  strong: "▰▰▰",
  moderate: "▰▰▱",
  weak: "▰▱▱",
};

function Panel({
  accent,
  title,
  role,
  children,
}: {
  accent: string;
  title: string;
  role: string;
  children: React.ReactNode;
}) {
  return (
    <article
      className="rounded-lg border border-line border-t-[3px] bg-panel p-5"
      style={{ borderTopColor: accent }}
    >
      <h3 className="font-serif text-xl leading-tight">{title}</h3>
      <p className="text-[11px] uppercase tracking-wider text-muted">{role}</p>
      {children}
    </article>
  );
}

function Section({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4 className="mt-4 border-t border-line pt-3 text-[11px] uppercase tracking-wider text-faint">
        {label}
      </h4>
      <ul className="list-disc pl-4.5 text-[14px]">
        {items.map((t, i) => (
          <li key={i} className="mb-2">
            {t}
          </li>
        ))}
      </ul>
    </>
  );
}

function Score({ value, caption, color }: { value: number; caption: string; color: string }) {
  return (
    <p className="mt-3 font-mono text-[26px] leading-none" style={{ color }}>
      {value}
      <span className="mt-1 block font-sans text-[11px] tracking-wide text-faint">
        {caption}
      </span>
    </p>
  );
}

export function AdvocatePanel({
  brief,
  accent,
  title,
  role,
  side,
}: {
  brief: AdvocateBrief | null;
  accent: string;
  title: string;
  role: string;
  side: string;
}) {
  if (!brief) {
    return (
      <Panel accent="var(--color-line)" title={title} role={role}>
        <p className="mt-3 text-[14px] text-faint">Failed to appear.</p>
      </Panel>
    );
  }

  return (
    <Panel accent={accent} title={title} role={role}>
      <Score value={brief.confidence} caption={`confidence claim is ${side}`} color={accent} />
      {brief.headline && (
        <p className="my-3.5 font-serif text-[#cfccc5] italic">{brief.headline}</p>
      )}

      <h4 className="mt-4 border-t border-line pt-3 text-[11px] uppercase tracking-wider text-faint">
        Evidence
      </h4>
      {brief.evidence.length ? (
        <ul className="text-[14px]">
          {brief.evidence.map((e, i) => (
            <li key={i} className="mb-2.5">
              <span className="mr-1.5 font-mono text-[10px] text-faint">
                {STRENGTH_BAR[e.strength]}
              </span>
              {e.point}
              <span className="block text-[12px] text-faint">{e.source}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-faint">No evidence filed.</p>
      )}

      <Section label="Flaws alleged in the other side" items={brief.fallacies} />
      <Section label="Concedes" items={brief.concessions} />
    </Panel>
  );
}

export function ExpertPanel({ brief }: { brief: ExpertBrief | null }) {
  if (!brief) {
    return (
      <Panel accent="var(--color-line)" title="Expert Witness" role="neutral">
        <p className="mt-3 text-[14px] text-faint">Failed to appear.</p>
      </Panel>
    );
  }

  return (
    <Panel
      accent="var(--color-exp)"
      title="Expert Witness"
      role="called by the court · neutral"
    >
      <Score
        value={brief.certainty}
        caption="how settled this is among experts"
        color="var(--color-exp)"
      />
      {brief.consensus && (
        <p className="my-3.5 font-serif text-[#cfccc5] italic">{brief.consensus}</p>
      )}

      <h4 className="mt-4 border-t border-line pt-3 text-[11px] uppercase tracking-wider text-faint">
        Key findings
      </h4>
      {brief.key_findings.length ? (
        <ul className="text-[14px]">
          {brief.key_findings.map((f, i) => (
            <li key={i} className="mb-2.5">
              {f.finding}
              <span className="block text-[12px] text-faint">
                {f.source} · {f.year}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-faint">None filed.</p>
      )}

      <Section label="Open questions" items={brief.open_questions} />
      <Section label="Commonly misread as" items={brief.common_misreadings} />
    </Panel>
  );
}
