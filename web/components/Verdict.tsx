"use client";

import { useEffect, useState } from "react";

import type { Trial, VerdictLabel } from "@/lib/types";

export const VERDICT_COLOR: Record<VerdictLabel, string> = {
  TRUE: "#4caf7d",
  "MOSTLY TRUE": "#7fb98a",
  MIXED: "#c9a227",
  "MOSTLY FALSE": "#d9764f",
  FALSE: "#e0574f",
};

export function VerdictCard({ trial }: { trial: Trial }) {
  const v = trial.verdict;
  const color = VERDICT_COLOR[v.verdict] ?? "#c9a227";

  // Fill the meter after mount so the bar animates to the score rather than
  // appearing already full.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(v.truth_score));
    return () => cancelAnimationFrame(id);
  }, [v.truth_score]);

  return (
    <section className="my-7 rounded-xl border border-line border-t-[3px] border-t-gold bg-gradient-to-b from-panel2 to-panel px-8 py-7">
      <h2 className="font-serif text-[46px] leading-none tracking-wide" style={{ color }}>
        {v.verdict}
      </h2>

      <div
        className="my-4 h-2.5 overflow-hidden rounded-full bg-[#23272f]"
        role="meter"
        aria-valuenow={v.truth_score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Truth score"
      >
        <div
          className="meter-fill h-full rounded-full"
          style={{ width: `${width}%`, background: color }}
        />
      </div>

      <div className="flex flex-wrap justify-between gap-2 text-[13px] text-muted">
        <span>
          truth score{" "}
          <b style={{ color }}>{v.truth_score}</b>
          /100
        </span>
        <span>
          judicial confidence: <b className="text-ink">{v.confidence}</b> · ruled in{" "}
          {trial.total_s}s
        </span>
      </div>

      {v.reasoning && (
        <p className="mt-5 font-serif text-[17px] text-[#d8d5cf]">{v.reasoning}</p>
      )}

      <div className="mt-6 grid gap-3.5 md:grid-cols-2">
        <Arg label="Strongest argument for" text={v.strongest_for} color="var(--color-def)" />
        <Arg
          label="Strongest argument against"
          text={v.strongest_against}
          color="var(--color-pro)"
        />
      </div>
    </section>
  );
}

function Arg({ label, text, color }: { label: string; text: string; color: string }) {
  return (
    <div
      className="rounded-md border-l-[3px] bg-[#12151a] px-4 py-3"
      style={{ borderLeftColor: color }}
    >
      <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">{label}</h3>
      <p className="text-[14px]">{text || "—"}</p>
    </div>
  );
}
