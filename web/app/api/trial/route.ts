import { NoProviderError } from "@/lib/config";
import { tryClaim } from "@/lib/engine";
import type { Role, StageState } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Five sequential model calls plus retrieval. The platform default is 300s;
// a trial normally finishes in under 15.
export const maxDuration = 300;

const MAX_CLAIM = 500;

/**
 * Streams a trial over Server-Sent Events so the courtroom fills in live as
 * each party files — which is the whole point of watching a trial.
 */
export async function GET(req: Request) {
  const claim = (new URL(req.url).searchParams.get("claim") ?? "").trim();
  if (!claim) {
    return Response.json({ error: "claim is required" }, { status: 400 });
  }
  if (claim.length > MAX_CLAIM) {
    return Response.json(
      { error: `claim too long (max ${MAX_CLAIM} characters)` },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true; // client disconnected mid-trial
        }
      };

      const progress = (role: Role, state: StageState) => send("progress", { role, state });

      try {
        const trial = await tryClaim(claim, { progress });
        send("verdict", trial);
      } catch (err) {
        const message =
          err instanceof NoProviderError
            ? err.message
            : err instanceof Error
              ? `${err.name}: ${err.message}`
              : String(err);
        send("error", { message });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
