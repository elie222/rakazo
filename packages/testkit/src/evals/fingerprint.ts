import { createHash } from "node:crypto";
import type { ModelConnectInput } from "@rakazo/contracts";
import type { EvalCase } from "./cases.js";

/**
 * What changes between two trials of an unchanged case without changing what the model is asked:
 * record ids, the clock (and dates written relative to it), and loopback ports. Ids become numbered
 * placeholders in order of appearance, so two different ids in one request stay distinct.
 */
const VOLATILE: Array<[RegExp, string | null]> = [
  [/\bc[a-z0-9]{24}\b/g, null],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, null],
  [/\b(?:127\.0\.0\.1|localhost):\d+/g, "<loopback>"],
  [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
    "<date>",
  ],
  [/\b\d{4}\/\d{2}\/\d{2}\b/g, "<date>"],
  [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? {1,2}\d{1,2}(?:, \d{4})?\b/g,
    "<date>",
  ],
  [/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day|sday|nesday|rsday|urday)?\b/g, "<day>"],
];

/**
 * A model request body as sent, reduced to what drives the reply: keys sorted, and the volatile
 * values above replaced. Non-JSON bodies are kept as they are.
 */
export function canonicalModelRequest(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return normalize(body, new Map());
  }
  const ids = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return normalize(value, ids);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, walk((value as Record<string, unknown>)[key])]),
      );
    return value;
  };
  return JSON.stringify(walk(parsed));
}

function normalize(text: string, ids: Map<string, string>) {
  let out = text;
  for (const [pattern, replacement] of VOLATILE)
    out = out.replace(pattern, (match) => {
      if (replacement !== null) return replacement;
      if (!ids.has(match)) ids.set(match, `<id${ids.size + 1}>`);
      return ids.get(match)!;
    });
  return out;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Sorted-key JSON, so the same settings always hash the same. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/** Connection settings that shape replies; the key, label and save options do not. */
export function modelSettings(connection: ModelConnectInput) {
  const {
    apiKey: _apiKey,
    label: _label,
    credentialId: _credentialId,
    makeDefault: _makeDefault,
    scope: _scope,
    ...settings
  } = connection;
  return settings;
}

/**
 * One case and strategy's fingerprint: its first model request as sent, the model and its settings,
 * the case's fixture version and data, and the trial controls the product reads. The judge is kept
 * out, so a new rubric regrades stored replies instead of rerunning the bot.
 */
export function caseFingerprint(input: {
  request: string;
  connection: ModelConnectInput;
  caseVersion: string;
  scenario: EvalCase;
  strategy: string;
  replyMode: string;
  maxToolCalls: number;
}): string {
  return sha256(
    stable({
      v: 1,
      request: canonicalModelRequest(input.request),
      model: modelSettings(input.connection),
      caseVersion: input.caseVersion,
      // Functions drop out; the steps, files and scripts a case feeds the bot later stay.
      caseData: canonicalModelRequest(JSON.stringify(input.scenario)),
      strategy: input.strategy,
      replyMode: input.replyMode,
      maxToolCalls: input.maxToolCalls,
    }),
  );
}

/**
 * The run's fingerprint over its cases' fingerprints. A case that never reached the model, or
 * whose first request changed between trials, has none and is left out; with none at all, null.
 */
export function runFingerprint(cases: Record<string, string | null>): string | null {
  const entries = Object.entries(cases)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return null;
  return sha256(entries.map(([key, value]) => `${key}\n${value}\n`).join(""));
}

export const caseKey = (caseId: string, strategy: string | undefined) =>
  `${caseId}/${strategy ?? "current"}`;

/**
 * Hands the first request for the eval model to `onFirst` before it is sent. When that returns
 * false, the request and every later one fail without reaching the provider.
 */
export function firstRequestFetch(
  upstream: typeof fetch,
  modelId: string,
  onFirst: (body: string) => boolean,
): typeof fetch {
  let seen = false;
  let open = true;
  return (input, init) => {
    if (!seen && typeof init?.body === "string" && isFor(input, init.body, modelId)) {
      seen = true;
      open = onFirst(init.body);
    }
    if (!open) return Promise.reject(new Error("Stored trials replace this run"));
    return upstream(input, init);
  };
}

/** Most protocols name the model in the body; some put it in the path. */
function isFor(input: Parameters<typeof fetch>[0], body: string, modelId: string) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes(`/${encodeURIComponent(modelId)}`) || url.includes(`/${modelId}`)) return true;
  try {
    return (JSON.parse(body) as { model?: unknown }).model === modelId;
  } catch {
    return false;
  }
}
