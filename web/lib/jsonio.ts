/**
 * Getting clean JSON out of models that insist on decorating it.
 *
 * Every failure mode handled here was observed from a live model, not
 * anticipated:
 *   1. markdown fences  ```json ... ```
 *   2. reasoning models emitting <think>...</think> before the payload,
 *      sometimes truncated so only the closing tag survives
 *   3. prose preamble ("Here is the analysis:") before the opening brace
 *   4. unquoted string values — llama-3.3-70b reliably emits
 *      `"headline": The claim is false,` with the rest of the object perfect
 *   5. truncation mid-string or mid-array when a model runs out of budget
 */

const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
const THINK = /<think>[\s\S]*?<\/think>/gi;
const OPEN_THINK = /^[\s\S]*?<\/think>/i;
const TRAILING_COMMA = /,(\s*[}\]])/g;

// The value pattern must start at a non-space character. Without that anchor
// the trailing [ \t]* backtracks, the lookahead lands on a space instead of the
// first real character, and legitimate numbers and arrays get quoted too.
const BARE_VALUE =
  /^(?<pre>[ \t]*"[^"\n]+"[ \t]*:[ \t]*)(?<val>(?!["[{\d-]|true\b|false\b|null\b)\S[^\n]*?)(?<comma>,?)[ \t]*$/gm;

export class JSONRecoveryError extends Error {}

/** First balanced {...} block, ignoring braces inside strings. */
function balancedSlice(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function quoteBareValues(text: string): string {
  return text.replace(BARE_VALUE, (match, ...args) => {
    const groups = args[args.length - 1] as {
      pre: string;
      val: string;
      comma: string;
    };
    const val = groups.val.trim();
    if (!val || ["{", "[", "}", "]"].includes(val)) return match;
    const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${groups.pre}"${escaped}"${groups.comma}`;
  });
}

/**
 * Close a response that ran out of tokens mid-object. A truncated brief still
 * carries most of its evidence; recovering it beats spending another round
 * trip to get the same content back.
 */
function closeTruncated(text: string): string {
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (const ch of text) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if ((ch === "}" || ch === "]") && stack.length) stack.pop();
  }

  if (!inStr && stack.length === 0) return text;

  let out = text.replace(/\s+$/, "");
  if (inStr) out += '"';
  // Drop a dangling  "key":  or trailing comma that would break the close.
  out = out.replace(/,\s*$/, "");
  out = out.replace(/"[^"\n]*"\s*:\s*$/, "").replace(/\s+$/, "").replace(/,$/, "");
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** Best-effort parse of a model response into an object. Throws on total failure. */
export function extractJson(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) throw new JSONRecoveryError("empty response");

  let text = raw.replace(THINK, "");
  // A truncated reasoning block leaves a dangling </think> with no opener.
  if (text.includes("</think>")) text = text.replace(OPEN_THINK, "");
  text = text.trim();

  const candidates: string[] = [];
  for (const m of text.matchAll(FENCE)) candidates.push(m[1].trim());
  candidates.push(text);
  const block = balancedSlice(text);
  if (block) candidates.push(block);

  // Salvage passes, cheapest and least invasive first. Each builds on the
  // previous, so a response that is both truncated and missing quotes still
  // comes back.
  for (const candidate of candidates) {
    if (!candidate) continue;
    let s = candidate;
    const variants = [s];
    s = s.replace(TRAILING_COMMA, "$1");
    variants.push(s);
    s = quoteBareValues(s);
    variants.push(s);
    variants.push(closeTruncated(s));

    for (const attempt of variants) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "object") {
          return parsed[0] as Record<string, unknown>;
        }
      } catch {
        // try the next variant
      }
    }
  }

  throw new JSONRecoveryError(
    `no parseable JSON object in ${raw.length} chars of output`,
  );
}

/**
 * A terse re-ask, appended to the live conversation.
 *
 * This is deliberately *not* a fresh prompt. An earlier version replaced the
 * history with this text alone, and the Judge — having lost the briefs it was
 * meant to rule on — dutifully reported that no arguments had been provided.
 */
export function repairPrompt(schema: unknown, error: string): string {
  return (
    "STOP. Your last response could not be parsed.\n" +
    `Parser error: ${error}\n\n` +
    "The task above is unchanged. Answer it again, but this time emit " +
    "nothing except a single valid JSON object of this shape:\n" +
    JSON.stringify(schema, null, 2) +
    "\n\nBegin your response with the character { and end it with the character }. " +
    "Do not think out loud. Do not use markdown fences. Do not explain. " +
    "If you were cut off last time, be brief — a short complete JSON object " +
    "is far better than a long truncated one."
  );
}

/** Models return scores as 72, "72", "72/100", or 0.72. Normalize all of them. */
export function coerceInt(value: unknown, def = 50, lo = 0, hi = 100): number {
  if (typeof value === "boolean") return def;
  if (typeof value === "number" && Number.isFinite(value)) {
    let n = value;
    if (n > 0 && n <= 1 && !Number.isInteger(n)) n *= 100;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  if (typeof value === "string") {
    const m = value.match(/-?\d+(?:\.\d+)?/);
    if (m) return coerceInt(parseFloat(m[0]), def, lo, hi);
  }
  return def;
}

/** Normalize a field the model may have returned as a bare string or null. */
export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== "");
  return [value];
}

export function asStringList(value: unknown): string[] {
  return asList(value).map((v) => String(v));
}
