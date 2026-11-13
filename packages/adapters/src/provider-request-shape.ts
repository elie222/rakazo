import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * The shape of a model request a provider rejected, safe to log: key names, counts, part types,
 * numbers, booleans and a few known enum settings. Never prompt or message text, tool arguments
 * or results, file data, identifiers, keys or headers.
 */
export interface RejectedProviderRequest {
  provider: string;
  model: string;
  status: number;
  endpoint?: string;
  requestId?: string;
  body?: ProviderRequestShape;
}

export interface ProviderRequestShape {
  bytes?: number;
  keys: string[];
  params: Record<string, string | number | boolean | string[]>;
  tools?: { count: number; names: string[] };
  messages?: { count: number; items: string[] };
}

/** Content the summary describes by structure only. */
const CONTENT_KEYS = new Set([
  "messages",
  "input",
  "contents",
  "instructions",
  "system",
  "systemInstruction",
  "system_instruction",
  "prompt",
  "tools",
  "metadata",
]);
/** Settings whose string values are fixed vocabularies, never free text or identifiers. */
const ENUM_SETTINGS = new Set([
  "model",
  "tool_choice",
  "tool_choice.type",
  "tool_choice.name",
  "tool_choice.function.name",
  "service_tier",
  "truncation",
  "reasoning_effort",
  "reasoning.effort",
  "reasoning.summary",
  "text.verbosity",
  "text.format.type",
  "response_format.type",
  "thinking.type",
  "include",
  "modalities",
]);
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function", "model"]);
const TOKEN = /^[a-z][\w.:-]{0,63}$/i;
const MAX_ITEMS = 120;
const MAX_TOOL_NAMES = 200;
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"];
const REQUEST_ID = /^[\w.:-]{1,128}$/;

function token(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeSetting(
  path: string,
  value: unknown,
  params: ProviderRequestShape["params"],
  depth: number,
) {
  if (typeof value === "number" || typeof value === "boolean") params[path] = value;
  else if (typeof value === "string")
    params[path] = (ENUM_SETTINGS.has(path) && token(value)) || "string";
  else if (Array.isArray(value)) {
    const values = value.map(token);
    params[path] =
      ENUM_SETTINGS.has(path) && values.every((item) => item !== undefined)
        ? (values as string[])
        : `array(${value.length})`;
  } else if (record(value) && depth < 3) {
    for (const [key, nested] of Object.entries(value as object))
      describeSetting(`${path}.${key}`, nested, params, depth + 1);
  } else if (value !== undefined) params[path] = value === null ? "null" : "object";
}

function toolName(tool: unknown): string[] {
  const item = record(tool);
  if (!item) return ["?"];
  const declarations = item.functionDeclarations ?? item.function_declarations;
  if (Array.isArray(declarations)) return declarations.flatMap(toolName);
  return [token(item.name) ?? token(record(item.function)?.name) ?? token(item.type) ?? "?"];
}

function partTypes(content: unknown): string {
  if (typeof content === "string") return "text";
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      if (!item) return typeof part === "string" ? "text" : "?";
      // Parts without a type tag are named by their single content key, as in `{ text }`.
      return token(item.type) ?? Object.keys(item).filter(Boolean).sort().join("|");
    })
    .join("+");
}

function describeMessage(message: unknown): string {
  const item = record(message);
  if (!item) return typeof message === "string" ? "text" : "?";
  const role = typeof item.role === "string" && ROLES.has(item.role) ? item.role : undefined;
  const label = [role, token(item.type)].filter(Boolean).join("/") || "?";
  const parts = partTypes(item.content ?? item.parts);
  return parts ? `${label}:${parts}` : label;
}

/** Runs of identical entries collapse to `entry x3`; long lists keep their newest entries. */
function compact(items: string[]): string[] {
  const runs: string[] = [];
  let index = 0;
  while (index < items.length) {
    let end = index + 1;
    while (end < items.length && items[end] === items[index]) end += 1;
    runs.push(end - index > 1 ? `${items[index]} x${end - index}` : (items[index] as string));
    index = end;
  }
  return runs.length > MAX_ITEMS ? ["…", ...runs.slice(-MAX_ITEMS)] : runs;
}

export function summarizeProviderRequest(payload: unknown): ProviderRequestShape | undefined {
  const body = record(payload);
  if (!body) return undefined;
  const params: ProviderRequestShape["params"] = {};
  for (const [key, value] of Object.entries(body))
    if (!CONTENT_KEYS.has(key)) describeSetting(key, value, params, 0);
  const shape: ProviderRequestShape = { keys: Object.keys(body).sort(), params };
  try {
    shape.bytes = JSON.stringify(body).length;
  } catch {}
  if (Array.isArray(body.tools)) {
    const names = body.tools.flatMap(toolName);
    shape.tools = { count: names.length, names: names.slice(0, MAX_TOOL_NAMES) };
  }
  const messages = [body.messages, body.input, body.contents].find(Array.isArray);
  if (messages)
    shape.messages = { count: messages.length, items: compact(messages.map(describeMessage)) };
  return shape;
}

/** The path only; segments that look like account, deployment or resource ids are masked. */
export function endpointPath(url: string): string | undefined {
  try {
    return new URL(url).pathname
      .split("/")
      .map((segment) =>
        /^[\da-f-]{16,}$/i.test(segment) || /\d{6,}/.test(segment) || segment.length > 64
          ? ":id"
          : segment,
      )
      .join("/");
  } catch {
    return undefined;
  }
}

/**
 * Stream options that report each response: the request's shape when it was rejected with a
 * 4xx, and undefined when it was not, so only the latest attempt's rejection is kept.
 */
export function withRejectedRequestCapture<O extends SimpleStreamOptions>(
  options: O,
  onRejected: (rejection: RejectedProviderRequest | undefined) => void,
): O {
  let payload: unknown;
  let endpoint: string | undefined;
  const { fetch, onPayload, onResponse } = options;
  return {
    ...options,
    onPayload: async (body, model) => {
      const replaced = await onPayload?.(body, model);
      payload = replaced ?? body;
      return replaced;
    },
    ...(fetch
      ? {
          fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            endpoint = endpointPath(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            return fetch(input, init);
          },
        }
      : {}),
    onResponse: async (response, model) => {
      if (response.status >= 400 && response.status < 500) {
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
        );
        const requestId = REQUEST_ID_HEADERS.map((name) => headers[name]).find(
          (value) => value !== undefined && REQUEST_ID.test(value),
        );
        onRejected({
          provider: model.provider,
          model: model.id,
          status: response.status,
          ...(endpoint ? { endpoint } : {}),
          ...(requestId ? { requestId } : {}),
          body: summarizeProviderRequest(payload),
        });
      } else onRejected(undefined);
      return onResponse?.(response, model);
    },
  };
}

const rejections = new WeakMap<Error, RejectedProviderRequest>();

export function attachRejectedRequest<E extends Error>(
  error: E,
  rejection: RejectedProviderRequest | undefined,
): E {
  if (rejection) rejections.set(error, rejection);
  return error;
}

export function rejectedRequestOf(error: unknown): RejectedProviderRequest | undefined {
  return error instanceof Error ? rejections.get(error) : undefined;
}
