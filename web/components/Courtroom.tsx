"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Bench } from "./Bench";
import { AdvocatePanel, ExpertPanel } from "./Briefs";
import { CitationAudit } from "./CitationAudit";
import { EvidenceRetrieved } from "./Evidence";
import { VerdictCard } from "./Verdict";
import type { Role, RosterEntry, StageState, Trial } from "@/lib/types";

const EXAMPLES = [
  "The Great Wall of China is visible from space",
  "Social media causes depression in teenagers",
  "Goldfish have a three-second memory",
  "Nuclear power is more dangerous than coal",
  "We only use 10% of our brains",
];

export function Courtroom() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [claim, setClaim] = useState("");
  const [states, setStates] = useState<Partial<Record<Role, StageState>>>({});
  const [trial, setTrial] = useState<Trial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/roster")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setRoster(d.roster)))
      .catch((e) => setError(String(e)));
    return () => sourceRef.current?.close();
  }, []);

  const start = useCallback((text: string) => {
    const value = text.trim();
    if (!value) return;

    sourceRef.current?.close();
    setError(null);
    setTrial(null);
    setRunning(true);
    setStates({});

    const es = new EventSource(`/api/trial?claim=${encodeURIComponent(value)}`);
    sourceRef.current = es;

    es.addEventListener("progress", (e) => {
      const { role, state } = JSON.parse((e as MessageEvent).data);
      setStates((prev) => ({ ...prev, [role as Role]: state as StageState }));
    });

    es.addEventListener("verdict", (e) => {
      setTrial(JSON.parse((e as MessageEvent).data) as Trial);
      setRunning(false);
      es.close();
    });

    es.addEventListener("error", (e) => {
      let message = "The connection to the courtroom was lost.";
      try {
        message = JSON.parse((e as MessageEvent).data).message;
      } catch {
        // A transport-level error carries no data payload.
      }
      setError(message);
      setRunning(false);
      es.close();
    });

    // Fires on transport failure as well as on normal close; only surface it if
    // the stream died before delivering a verdict.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setRunning(false);
    };
  }, []);

  return (
    <main className="mx-auto max-w-[1180px] px-6 pt-10 pb-24">
      <header className="border-b border-line pt-7 pb-8 text-center">
        <h1 className="font-serif text-[44px] leading-none tracking-wide">
          Veritas<span className="text-gold">AI</span>
        </h1>
        <p className="mt-2 font-serif text-[17px] text-muted italic">
          Every claim deserves a trial.
        </p>
      </header>

      <form
        className="mt-7 mb-3.5 flex flex-col gap-2.5 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          start(claim);
        }}
      >
        <label htmlFor="claim" className="sr-only">
          Claim to put on trial
        </label>
        <input
          id="claim"
          type="text"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
          placeholder="Enter a claim to put on trial…"
          className="flex-1 rounded-lg border border-line bg-panel px-4.5 py-3.5 font-serif text-base text-ink outline-none focus:border-gold"
        />
        <button
          type="submit"
          disabled={running || !claim.trim()}
          className="rounded-lg bg-gold px-7 py-3.5 text-[15px] font-bold tracking-wide text-[#17140a] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {running ? "In session…" : "Convene"}
        </button>
      </form>

      <div className="mb-6 flex flex-wrap gap-2">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            type="button"
            disabled={running}
            onClick={() => {
              setClaim(e);
              start(e);
            }}
            className="rounded-full border border-line bg-panel px-3 py-1.5 text-[13px] text-muted hover:border-faint hover:text-ink disabled:opacity-45"
          >
            {e}
          </button>
        ))}
      </div>

      <Bench roster={roster} states={states} />

      {error && (
        <p
          role="alert"
          className="my-5 rounded-lg border border-[#4a2529] bg-[#2a1618] px-4.5 py-3.5 text-[14px] text-[#f0b7b3]"
        >
          {error}
        </p>
      )}

      {trial && <TrialReport trial={trial} />}

      <footer className="mt-16 text-center text-[12px] text-faint">
        5 models · 3 adversarial roles · live retrieval · citation audit · 1 verdict
      </footer>
    </main>
  );
}

function TrialReport({ trial }: { trial: Trial }) {
  const v = trial.verdict;
  const d = v.briefs.docket;

  return (
    <>
      <VerdictCard trial={trial} />

      {v.nuances.length > 0 && (
        <>
          <SectionTitle>Nuances the verdict rests on</SectionTitle>
          <div className="rounded-lg border border-line bg-panel px-6 py-5">
            <ul className="list-disc pl-4.5">
              {v.nuances.map((n, i) => (
                <li key={i} className="mb-2 font-serif text-[15px]">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <SectionTitle>The briefs</SectionTitle>
      <div className="grid gap-3.5 lg:grid-cols-3">
        <AdvocatePanel
          brief={v.briefs.prosecution}
          accent="var(--color-pro)"
          title="The Prosecution"
          role="arguing the claim is false"
          side="false"
        />
        <ExpertPanel brief={v.briefs.expert} />
        <AdvocatePanel
          brief={v.briefs.defense}
          accent="var(--color-def)"
          title="The Defense"
          role="arguing the claim is true"
          side="true"
        />
      </div>

      <SectionTitle>The docket</SectionTitle>
      <div className="rounded-lg border border-line bg-panel px-6 py-5">
        <p className="mb-3 font-mono text-[12px] text-faint">
          domain: {d.domain} · type: {d.claim_type}
        </p>
        <ul className="list-disc pl-4.5">
          {d.sub_claims.map((s) => (
            <li key={s.id} className="mb-2 font-serif text-[15px]">
              {s.text}
            </li>
          ))}
        </ul>
        {d.ambiguities.length > 0 && (
          <>
            <h4 className="mt-4 border-t border-line pt-3 text-[11px] uppercase tracking-wider text-faint">
              Contested terms
            </h4>
            <ul className="list-disc pl-4.5">
              {d.ambiguities.map((a, i) => (
                <li key={i} className="mb-1 text-[14px]">
                  {a}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <CitationAudit report={v.citations} />
      <EvidenceRetrieved data={v.grounding} />

      {v.recommended_reading.length > 0 && (
        <>
          <SectionTitle>Recommended reading</SectionTitle>
          <div className="rounded-lg border border-line bg-panel px-6 py-5">
            <ul className="list-disc pl-4.5">
              {v.recommended_reading.map((r, i) => (
                <li key={i} className="mb-2 text-[14px]">
                  {r}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <SectionTitle>Trial record</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12.5px]">
          <thead>
            <tr>
              {["stage", "provider", "model", "time", "repairs", "status"].map((h) => (
                <th
                  key={h}
                  className="border-b border-line px-2.5 py-1.5 text-left text-[10px] font-normal uppercase tracking-wider text-faint"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trial.nodes.map((n, i) => (
              <tr key={i}>
                <td className="border-b border-[#1b1f27] px-2.5 py-1.5 text-muted">{n.role}</td>
                <td className="border-b border-[#1b1f27] px-2.5 py-1.5 text-muted">{n.provider}</td>
                <td className="border-b border-[#1b1f27] px-2.5 py-1.5 text-muted">{n.model}</td>
                <td className="border-b border-[#1b1f27] px-2.5 py-1.5 text-muted">{n.latency_s}s</td>
                <td className="border-b border-[#1b1f27] px-2.5 py-1.5 text-muted">{n.repairs}</td>
                <td
                  className={`max-w-[22rem] border-b border-[#1b1f27] px-2.5 py-1.5 break-words ${n.ok ? "text-def" : "text-pro"}`}
                >
                  {n.ok ? "ok" : n.error}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-9 mb-3.5 font-serif text-[15px] uppercase tracking-[2.4px] text-muted">
      {children}
    </h2>
  );
}
