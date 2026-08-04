import { NextResponse } from "next/server";

import { CITATIONS, GROUNDING, MODEL_ROLES, NoProviderError, ROLE_LABELS, STAGES } from "@/lib/config";
import { resolve } from "@/lib/engine";
import type { RosterEntry } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DETAIL: Record<string, string> = {
  [GROUNDING]: "crossref · wikipedia · web",
  [CITATIONS]: "crossref lookup",
};

export async function GET() {
  try {
    const roster = await resolve();
    const entries: RosterEntry[] = STAGES.map((role) => ({
      role,
      label: ROLE_LABELS[role],
      provider: MODEL_ROLES.includes(role) ? roster[role].provider.name : "direct",
      model: MODEL_ROLES.includes(role) ? roster[role].model : DETAIL[role],
    }));
    return NextResponse.json({ roster: entries });
  } catch (err) {
    const message = err instanceof NoProviderError ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
