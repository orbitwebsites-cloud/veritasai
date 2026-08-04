import type { RosterEntry, Role, StageState } from "@/lib/types";

const STATE_STYLE: Record<StageState, { border: string; label: string; text: string }> = {
  pending: { border: "border-line", label: "waiting", text: "text-faint" },
  running: { border: "border-gold", label: "running", text: "text-gold animate-stage-pulse" },
  repairing: { border: "border-gold", label: "repairing", text: "text-gold animate-stage-pulse" },
  done: { border: "border-def/40", label: "done", text: "text-def" },
  failed: { border: "border-pro/40", label: "failed", text: "text-pro" },
};

export function Bench({
  roster,
  states,
}: {
  roster: RosterEntry[];
  states: Partial<Record<Role, StageState>>;
}) {
  if (!roster.length) return null;

  return (
    <ol
      className="my-6 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]"
      aria-label="Trial progress"
    >
      {roster.map((r) => {
        const state = states[r.role] ?? "pending";
        const s = STATE_STYLE[state];
        return (
          <li
            key={r.role}
            className={`rounded-lg border bg-panel px-3.5 py-3 transition-colors ${s.border}`}
          >
            <div className="font-serif text-[15px] leading-tight">{r.label}</div>
            <div className="mt-1 font-mono text-[11px] break-all text-faint">{r.model}</div>
            <div className={`mt-1.5 text-[11px] uppercase tracking-wider ${s.text}`}>
              {s.label}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
