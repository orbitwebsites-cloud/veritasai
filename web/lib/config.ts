/**
 * Provider registry and role -> model resolution.
 *
 * VeritasAI's whole premise is that different models argue differently. The
 * roster below assigns each courtroom role to a *different model family* so the
 * Prosecution and the Defense are not the same mind wearing two hats.
 *
 * Everything here speaks the OpenAI wire format. Cerebras and Groq each host
 * several open-weight families behind one key, which is how a free tier still
 * buys real model diversity.
 */

import type { Role } from "./types";

export interface Provider {
  name: string;
  apiKeyEnv: string;
  baseUrl: string;
}

export const PROVIDERS: Record<string, Provider> = {
  cerebras: {
    name: "cerebras",
    apiKeyEnv: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
  },
  groq: {
    name: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  openai: {
    name: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
  },
};

export function apiKey(p: Provider): string | null {
  const v = process.env[p.apiKeyEnv];
  return v && v.trim() ? v.trim() : null;
}

export function availableProviders(): Provider[] {
  return Object.values(PROVIDERS).filter((p) => apiKey(p) !== null);
}

export const MODEL_ROLES: Role[] = [
  "decomposer",
  "prosecution",
  "expert",
  "defense",
  "judge",
];

export const GROUNDING: Role = "grounding";
export const CITATIONS: Role = "citations";

/** Display order, including the two stages that use no model. */
export const STAGES: Role[] = [
  "grounding",
  "decomposer",
  "prosecution",
  "expert",
  "defense",
  "judge",
  "citations",
];

export const ROLE_LABELS: Record<Role, string> = {
  grounding: "Court Researcher",
  decomposer: "Claim Decomposer",
  prosecution: "The Prosecution",
  expert: "Expert Witness",
  defense: "The Defense",
  judge: "The Judge",
  citations: "Citation Clerk",
};

/**
 * Each role lists candidates in preference order. The first candidate whose
 * provider has a key — and whose model the provider actually serves — wins.
 * Deliberately spread across Llama / Gemma / GPT-OSS / GLM so the adversarial
 * nodes genuinely disagree instead of echoing one pretraining distribution.
 */
export const ROSTER: Record<string, [string, string][]> = {
  // Clerical work. Smallest model that can hold a schema.
  decomposer: [
    ["groq", "llama-3.1-8b-instant"],
    ["cerebras", "gemma-4-31b"],
    ["openai", "gpt-4o-mini"],
  ],
  // Llama family. Paired against a Gemma-family Defense on purpose.
  prosecution: [
    ["groq", "llama-3.3-70b-versatile"],
    ["cerebras", "gpt-oss-120b"],
    ["openai", "gpt-4o-mini"],
  ],
  // GPT-OSS — neither advocate's lineage, which is the point of a
  // court-appointed witness.
  expert: [
    ["cerebras", "gpt-oss-120b"],
    ["groq", "openai/gpt-oss-120b"],
    ["openai", "gpt-4o"],
  ],
  // Gemma family (Google lineage): a different pretraining distribution from
  // the Llama Prosecution, which is what makes the two briefs independent
  // rather than one model arguing with itself.
  defense: [
    ["cerebras", "gemma-4-31b"],
    ["groq", "qwen/qwen3.6-27b"],
    ["groq", "llama-3.3-70b-versatile"],
  ],
  // The bench gets the strongest available model. Synthesis across three
  // conflicting briefs is the one place a reasoning model pays for itself.
  judge: [
    ["cerebras", "zai-glm-4.7"],
    ["cerebras", "gpt-oss-120b"],
    ["groq", "qwen/qwen3.6-27b"],
    ["openai", "gpt-4o"],
  ],
};

// Models that stream chain-of-thought in <think> tags and therefore need a
// larger budget before they write a single character of JSON.
const REASONING_HINTS = ["qwen-3", "qwen3", "gpt-oss", "deepseek", "glm"];

export interface Assignment {
  role: Role;
  provider: Provider;
  model: string;
  isReasoning: boolean;
}

function makeAssignment(role: Role, provider: Provider, model: string): Assignment {
  return {
    role,
    provider,
    model,
    isReasoning: REASONING_HINTS.some((h) => model.toLowerCase().includes(h)),
  };
}

export class NoProviderError extends Error {}

// Non-chat models that appear in /v1/models listings and must never be picked.
const NOT_CHAT = ["embed", "whisper", "tts", "rerank", "guard", "moderation"];

function pickFallback(
  live: Provider[],
  catalog: Record<string, Set<string>> | null,
): Assignment | null {
  for (const provider of live) {
    const served = catalog?.[provider.name];
    for (const candidates of Object.values(ROSTER)) {
      for (const [pname, model] of candidates) {
        if (pname === provider.name && (!served || served.has(model))) {
          return makeAssignment("judge", provider, model);
        }
      }
    }
    if (served) {
      const usable = [...served]
        .sort()
        .filter((m) => !NOT_CHAT.some((bad) => m.toLowerCase().includes(bad)));
      if (usable.length) return makeAssignment("judge", provider, usable[0]);
    }
  }
  return null;
}

/**
 * Every usable candidate for a role, in preference order.
 *
 * The pipeline fires three requests at once and free tiers answer bursts with
 * 429 "high traffic". Retrying the same overloaded model does not help; moving
 * to a different provider does. This list is what makes that possible, and it
 * matters most for the Defense — losing that node costs the adversarial premise
 * the whole project rests on.
 */
export function resolveCandidates(
  catalog: Record<string, Set<string>> | null = null,
): Record<Role, Assignment[]> {
  const out = {} as Record<Role, Assignment[]>;
  const primary = resolveRoster(catalog);

  for (const role of MODEL_ROLES) {
    const seen = new Set<string>();
    const list: Assignment[] = [];

    const push = (a: Assignment) => {
      const key = `${a.provider.name}/${a.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push(a);
      }
    };

    push(primary[role]);
    for (const [pname, model] of ROSTER[role]) {
      const provider = PROVIDERS[pname];
      if (!provider || !apiKey(provider)) continue;
      const served = catalog?.[provider.name];
      if (served && !served.has(model)) continue;
      push(makeAssignment(role, provider, model));
    }

    // Last resort: any other role's working model on a provider we can reach,
    // preferring one from a different provider than the primary.
    for (const otherRole of MODEL_ROLES) {
      if (otherRole === role) continue;
      const a = primary[otherRole];
      if (a.provider.name !== primary[role].provider.name) {
        push(makeAssignment(role, a.provider, a.model));
      }
    }

    out[role] = list;
  }
  return out;
}

/**
 * Map every role to a concrete (provider, model) pair.
 *
 * Model IDs drift. Rather than hardcode and break, we verify against each
 * provider's live catalog and degrade to the next candidate. This is not
 * paranoia: the first version of this roster had every ID wrong, and without
 * verification all five roles silently collapsed onto one model — which would
 * have made the "multi-model" premise quietly untrue.
 */
export function resolveRoster(
  catalog: Record<string, Set<string>> | null = null,
): Record<Role, Assignment> {
  const live = availableProviders();
  if (!live.length) {
    throw new NoProviderError(
      "No API key found. Set CEREBRAS_API_KEY or GROQ_API_KEY " +
        "(both have free tiers) in your environment.",
    );
  }

  const serves = (provider: Provider, model: string) => {
    const served = catalog?.[provider.name];
    return !served || served.has(model);
  };

  const fallback = pickFallback(live, catalog);
  const resolved = {} as Record<Role, Assignment>;

  for (const role of MODEL_ROLES) {
    let pick: Assignment | null = null;
    for (const [pname, model] of ROSTER[role]) {
      const provider = PROVIDERS[pname];
      if (provider && apiKey(provider) && serves(provider, model)) {
        pick = makeAssignment(role, provider, model);
        break;
      }
    }
    if (!pick) {
      if (!fallback) {
        throw new NoProviderError(
          `No usable model for role '${role}' from providers ${live
            .map((p) => p.name)
            .join(", ")}.`,
        );
      }
      pick = { ...fallback, role };
    }
    resolved[role] = pick;
  }

  return resolved;
}

// --- Tunables ---------------------------------------------------------------

export const MAX_TOKENS = Number(process.env.VERITAS_MAX_TOKENS ?? 1600);
export const JUDGE_MAX_TOKENS = Number(process.env.VERITAS_JUDGE_MAX_TOKENS ?? 2200);
export const TEMPERATURE = Number(process.env.VERITAS_TEMPERATURE ?? 0.35);
export const REQUEST_TIMEOUT_MS = Number(process.env.VERITAS_TIMEOUT_MS ?? 90_000);
export const MAX_REPAIRS = Number(process.env.VERITAS_MAX_REPAIRS ?? 2);
