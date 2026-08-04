import { NoProviderError } from "@/lib/config";
import { tryClaim } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CLAIM = 500;

/**
 * Non-streaming equivalent of /api/trial, for the browser extension and for
 * scripts. CORS is open because the response contains no user data and no
 * credentials — the keys stay server-side.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const claim = (params.get("claim") ?? "").trim();

  const cors = { "Access-Control-Allow-Origin": "*" };

  if (!claim) {
    return Response.json({ error: "claim is required" }, { status: 400, headers: cors });
  }
  if (claim.length > MAX_CLAIM) {
    return Response.json(
      { error: `claim too long (max ${MAX_CLAIM} characters)` },
      { status: 400, headers: cors },
    );
  }

  try {
    const trial = await tryClaim(claim, {
      ground: params.get("ground") !== "0",
      verifyCitations: params.get("citations") !== "0",
    });
    return Response.json(trial, { headers: cors });
  } catch (err) {
    const status = err instanceof NoProviderError ? 503 : 500;
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status, headers: cors });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
