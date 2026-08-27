import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import {
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent } from "undici";
import {
  createAddressCheckedLookup,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isPrivateAddress,
  type ResolveHostname,
} from "./network-address.js";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./openai-compatible-url.js";

import {
  declaredVisionModelIds,
  inputModalities,
} from "./model-modalities.js";
export { OPENAI_COMPATIBLE_PROVIDER_ID };

/** Placeholder catalog model id; users enter the real id when connecting. */
export const OPENAI_COMPATIBLE_CATALOG_MODEL_ID = "custom";

/** Model ids this endpoint serves with vision, declared by the operator. */
export const OPENAI_COMPATIBLE_VISION_MODELS_ENV = "RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS";

export function openAiCompatibleVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(OPENAI_COMPATIBLE_VISION_MODELS_ENV);
}

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
const MAX_MODELS_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_IDS = 500;
const MAX_MODEL_ID_LENGTH = 256;

const OPENAI_COMPAT_BASE = "http://127.0.0.1:1/v1";
const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function openAiCompatibleModel(
  id: string,
  baseUrl: string,
  acceptsImages = false,
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: inputModalities(acceptsImages),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function openAiCompatibleProvider(models: Model<"openai-completions">[]): Provider {
  const api = openAICompletionsApi();
  const safeFetch = createOpenAiCompatibleFetch();
  const safeApi: ProviderStreams = {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: safeFetch }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: safeFetch }),
  };
  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: models[0]?.baseUrl ?? OPENAI_COMPAT_BASE,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        resolve: async () => ({
          auth: { apiKey: "local" },
          source: "OpenAI-compatible endpoint",
        }),
      },
    },
    models,
    api: safeApi,
  });
}

export function createOpenAiCompatibleLookup(
  url: URL,
  resolve: ResolveHostname = resolveHostname,
): LookupFunction {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const privateHostname = isPrivateOpenAiCompatibleHostname(hostname);
  return createAddressCheckedLookup(resolve, (addresses) => {
    if (addresses.length === 0) throw new Error("Model server did not resolve to an address");
    if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
      throw new Error("Model server hostname resolved to a blocked metadata address");
    }
    if (privateHostname) {
      if (
        addresses.some(
          (entry) =>
            isIP(entry.address) === 0 ||
            !isPrivateAddress(entry.address) ||
            isLinkLocalAddress(entry.address),
        )
      ) {
        throw new Error("Local model server hostname resolved outside the private network");
      }
      return;
    }
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("Public model server hostname resolved to a private address");
    }
  });
}

function headersCarryAuthorization(headers: HeadersInit): boolean {
  if (headers instanceof Headers) return Boolean(headers.get("authorization"));
  if (Array.isArray(headers)) {
    return headers.some(
      ([name, value]) => name.toLowerCase() === "authorization" && Boolean(value),
    );
  }
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === "authorization" && Boolean(value),
  );
}

/** Matches fetch: when init.headers is set it replaces Request headers entirely. */
function requestCarriesAuthorization(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers !== undefined) return headersCarryAuthorization(init.headers);
  return input instanceof Request ? Boolean(input.headers.get("authorization")) : false;
}

export function createOpenAiCompatibleFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  resolve: ResolveHostname = resolveHostname,
): typeof globalThis.fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = assertAllowedOpenAiCompatibleRequestUrl(rawUrl);
    if (requestCarriesAuthorization(input, init)) {
      assertHttpsForKeyedOpenAiCompatibleUrl(url, "present");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const dispatcher =
      isIP(hostname) === 0
        ? new Agent({ connect: { lookup: createOpenAiCompatibleLookup(url, resolve) } })
        : undefined;
    try {
      const response = await baseFetch(input instanceof Request ? input : url, {
        ...init,
        redirect: "error",
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: Agent });
      return dispatcher ? await closeDispatcherWithResponse(response, dispatcher) : response;
    } catch (error) {
      await dispatcher?.close().catch(() => undefined);
      throw error;
    }
  };
}

async function closeDispatcherWithResponse(
  response: Response,
  dispatcher: Agent,
): Promise<Response> {
  if (!response.body) {
    await dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Always-visible catalog provider with a placeholder model entry. */
export function openAiCompatibleCatalogProvider(): Provider {
  // The vision gate resolves against this catalog rather than the per-run
  // registry, so a model only declared at runtime would still read as
  // text-only. Register the operator's declared vision models here too.
  const visionModels = [...openAiCompatibleVisionModelIds()].map((id) =>
    openAiCompatibleModel(id, OPENAI_COMPAT_BASE, true),
  );
  return openAiCompatibleProvider([
    {
      ...openAiCompatibleModel(OPENAI_COMPATIBLE_CATALOG_MODEL_ID, OPENAI_COMPAT_BASE),
      name: "Custom model id",
    },
    ...visionModels,
  ]);
}

export function registerOpenAiCompatibleCatalog(models: MutableModels): MutableModels {
  models.setProvider(openAiCompatibleCatalogProvider());
  return models;
}

/** Register a concrete model + base URL for an agent run. */
export function registerOpenAiCompatibleRuntime(
  models: MutableModels,
  opts: { modelId: string; baseUrl: string },
): MutableModels {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  const modelId = opts.modelId.trim();
  const acceptsImages = openAiCompatibleVisionModelIds().has(modelId);
  models.setProvider(
    openAiCompatibleProvider([openAiCompatibleModel(modelId, baseUrl, acceptsImages)]),
  );
  return models;
}

export type OpenAiCompatibleConnectInput = {
  provider: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
};

export function prepareOpenAiCompatibleConnect(input: OpenAiCompatibleConnectInput): {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
} {
  const baseUrl = input.baseUrl?.trim();
  const modelId = input.modelId?.trim();
  if (!baseUrl) throw new Error("Base URL is required for OpenAI-compatible models");
  if (!modelId) throw new Error("Model id is required for OpenAI-compatible models");
  const allowed = assertAllowedOpenAiCompatibleUrl(baseUrl);
  const apiKey = input.apiKey?.trim();
  assertHttpsForKeyedOpenAiCompatibleUrl(allowed, apiKey);
  const normalized = allowed.href;
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

export type OpenAiCompatibleModelsResponse = {
  object?: string;
  data?: Array<{ id?: string }>;
  models?: Array<{ id?: string }>;
};

/** Shared suffix: /models probe is optional when the user already knows a model id. */
const OPENAI_COMPAT_PROBE_HAND_FILL_HINT = "You can still Connect with an explicit model id.";

function probeModelIds(body: OpenAiCompatibleModelsResponse): string[] {
  const entries = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : null;
  if (!entries) {
    throw new Error(
      `Model server response did not include a models list. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LENGTH || ids.length >= MAX_MODEL_IDS) {
      throw new Error("Model server returned too many or overly long model ids");
    }
    ids.push(id);
  }
  return ids;
}

async function readBoundedJson(response: Response): Promise<OpenAiCompatibleModelsResponse> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_MODELS_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
  if (!response.body) {
    throw new Error(
      `Model server returned an empty response. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MODELS_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as OpenAiCompatibleModelsResponse;
  } catch {
    throw new Error(`Model server returned invalid JSON. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
}

export async function probeOpenAiCompatibleModels(
  input: { baseUrl: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl);
  assertHttpsForKeyedOpenAiCompatibleUrl(baseUrl, input.apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    const safeFetch = createOpenAiCompatibleFetch(fetchImpl);
    const response = await safeFetch(new URL("models", `${baseUrl.href}/`).href, {
      headers,
      redirect: "error",
      signal: merged,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server redirects are not allowed. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server returned ${response.status}. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    const body = await readBoundedJson(response);
    return probeModelIds(body);
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError");
    if (aborted) {
      // Caller-cancelled probes keep the original AbortError; the 5s probe budget gets a hint.
      if (signal?.aborted) throw error;
      throw new Error(`Model server probe timed out. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
