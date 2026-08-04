/** Async chat over the OpenAI wire format, plus live model-catalog lookup. */

import {
  apiKey,
  availableProviders,
  REQUEST_TIMEOUT_MS,
  TEMPERATURE,
  type Assignment,
  type Provider,
} from "./config";

export class ProviderError extends Error {}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Free-tier providers return 429 under concurrent load, and this pipeline fires
// three requests at once by design. Without retries a burst silently costs a
// whole brief — which is exactly what happened the first time this ran.
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
// Only two attempts per model. The engine fails over to a *different provider*
// after this returns, and switching is far more likely to succeed than a third
// try against a host that just said "high traffic". Three attempts here plus
// failover pushed a worst-case trial to 45s; two keeps it near 15s without
// costing reliability.
const MAX_ATTEMPTS = 2;

/** Honour Retry-After when the provider sends one, else short backoff. */
function backoffMs(res: Response | null, attempt: number): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    // A provider asking us to wait longer than this is telling us to go
    // elsewhere; failover will handle it faster than waiting.
    if (Number.isFinite(secs) && secs > 0 && secs <= 3) return secs * 1000;
    if (Number.isFinite(secs) && secs > 3) return 0;
  }
  return Math.min(500 * 2 ** attempt, 2_000);
}

export async function chat(
  assignment: Assignment,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number = TEMPERATURE,
): Promise<string> {
  const key = apiKey(assignment.provider);
  if (!key) {
    throw new ProviderError(
      `${assignment.provider.name}: ${assignment.provider.apiKeyEnv} is not set`,
    );
  }

  const tag = `${assignment.provider.name}/${assignment.model}`;
  const body = JSON.stringify({
    model: assignment.model,
    messages: [{ role: "system", content: system }, ...messages],
    max_completion_tokens: maxTokens,
    temperature,
  });

  let lastError = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${assignment.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastError = `HTTP ${res.status} ${text.slice(0, 160)}`;
        if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
          await sleep(backoffMs(res, attempt));
          continue;
        }
        throw new ProviderError(`${tag}: ${lastError}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      if (!data.choices?.length) {
        throw new ProviderError(`${tag}: response contained no choices`);
      }
      return data.choices[0].message?.content ?? "";
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const name = err instanceof Error ? err.name : "Error";
      lastError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      // A timeout or dropped socket is worth one more try; a caller-side abort
      // (navigation away) is not, but that closes the stream anyway.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoffMs(null, attempt));
        continue;
      }
      throw new ProviderError(`${tag}: ${lastError}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ProviderError(`${tag}: ${lastError || "exhausted retries"}`);
}

/** Model IDs a provider actually serves. Empty set means "could not verify". */
async function fetchCatalog(provider: Provider): Promise<Set<string>> {
  const key = apiKey(provider);
  if (!key) return new Set();
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { data?: { id?: string }[] };
    return new Set((data.data ?? []).map((m) => m.id).filter(Boolean) as string[]);
  } catch {
    // Verification is best-effort by design: an unreachable catalog means we
    // trust the roster rather than refusing to run.
    return new Set();
  }
}

export async function buildCatalog(): Promise<Record<string, Set<string>> | null> {
  const providers = availableProviders();
  const results = await Promise.all(providers.map(fetchCatalog));
  const out: Record<string, Set<string>> = {};
  providers.forEach((p, i) => {
    if (results[i].size) out[p.name] = results[i];
  });
  return Object.keys(out).length ? out : null;
}
