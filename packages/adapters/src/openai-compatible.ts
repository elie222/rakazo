import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export const GATEWAY_PROVIDER_PREFIX = "gateway:";
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_DISCOVERY_MAX_BYTES = 1_000_000;
const MODEL_DISCOVERY_MAX_REDIRECTS = 3;

const blockedModelEndpointAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedModelEndpointAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedModelEndpointAddresses.addSubnet(network, prefix, "ipv6");
}

export interface ModelDiscoveryOptions {
  allowPrivateNetwork?: boolean;
}

export function isGatewayProvider(provider: string): boolean {
  return provider === OPENAI_COMPATIBLE_PROVIDER || provider.startsWith(GATEWAY_PROVIDER_PREFIX);
}

export function mintGatewayProviderId(): string {
  return `${GATEWAY_PROVIDER_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a base URL");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Base URL must be http or https");
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid http(s) base URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path || "/";
  return parsed.toString().replace(/\/+$/, "");
}

export function parseAvailableModels(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function serializeAvailableModels(models: string[]): string {
  return [...new Set(models.map((entry) => entry.trim()).filter(Boolean))].join("\n");
}

export function modelsFromKeyCoverage(value: string | string[] | null | undefined): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
    : parseAvailableModels(value);
}

export function unionAvailableModels(
  keys: Array<{ availableModels?: string | string[] | null }>,
): string[] {
  return [...new Set(keys.flatMap((key) => modelsFromKeyCoverage(key.availableModels)))];
}

export function secretIdForGatewayModel(
  credential: {
    secretId: string;
    keys: Array<{
      secretId: string;
      isActive: boolean;
      availableModels?: string | string[] | null;
    }>;
  },
  modelId?: string | null,
): string {
  const fallback = credential.keys.find((key) => key.isActive)?.secretId ?? credential.secretId;
  if (!modelId?.trim() || !credential.keys.length) return fallback;
  const matching = credential.keys.filter((key) =>
    modelsFromKeyCoverage(key.availableModels).includes(modelId),
  );
  if (!matching.length) return fallback;
  return matching.find((key) => key.isActive)?.secretId ?? matching[0]!.secretId;
}

const MODEL_FAMILY_LABELS: Array<[string, string]> = [
  ["gemini", "Gemini"],
  ["claude", "Claude"],
  ["gpt", "GPT"],
  ["o1", "OpenAI"],
  ["o3", "OpenAI"],
  ["o4", "OpenAI"],
  ["llama", "Llama"],
  ["mistral", "Mistral"],
  ["grok", "Grok"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["command", "Command"],
];

export function labelForDiscoveredModels(models: string[], fallback = "API key"): string {
  if (!models.length) return fallback;
  const lower = models.map((id) => id.toLowerCase());
  for (const [needle, label] of MODEL_FAMILY_LABELS) {
    const hits = lower.filter((id) => id.includes(needle)).length;
    if (hits === models.length || hits >= Math.max(1, Math.ceil(models.length * 0.7))) {
      return label;
    }
  }
  return fallback;
}

export async function tryFetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
  options?: ModelDiscoveryOptions,
): Promise<{ models: string[]; error: string }> {
  try {
    return {
      models: await fetchOpenAICompatibleModels(baseUrl, apiKey, signal, options),
      error: "",
    };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : "Could not list models",
    };
  }
}

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
  options?: ModelDiscoveryOptions,
): Promise<string[]> {
  let endpoint = new URL(`${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`);
  let authorization = apiKey?.trim() ? `Bearer ${apiKey.trim()}` : undefined;
  let response: Awaited<ReturnType<typeof requestModelEndpoint>> | undefined;
  for (let redirects = 0; ; redirects += 1) {
    response = await requestModelEndpoint(endpoint, authorization, signal, options);
    const location = response.headers.location;
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    if (redirects >= MODEL_DISCOVERY_MAX_REDIRECTS) {
      throw new Error("Model endpoint redirected too many times");
    }
    const next = new URL(location, endpoint);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error("Model endpoint redirected to a non-http URL");
    }
    if (next.origin !== endpoint.origin) authorization = undefined;
    endpoint = next;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not list models (${response.status})`);
  }
  let body: { data?: unknown; models?: unknown };
  try {
    body = JSON.parse(response.body) as { data?: unknown; models?: unknown };
  } catch {
    throw new Error("Model endpoint returned invalid JSON");
  }
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const ids = rows.flatMap((row) => {
    if (typeof row === "string") return [row];
    if (row && typeof row === "object" && "id" in row) return [String((row as { id: unknown }).id)];
    return [];
  });
  if (!ids.length) throw new Error("That endpoint did not return any models");
  return [...new Set(ids)];
}

export async function assertOpenAICompatibleEndpointAllowed(
  baseUrl: string,
  options?: ModelDiscoveryOptions,
): Promise<string> {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  await resolveModelEndpointAddress(new URL(normalized), options);
  return normalized;
}

async function resolveModelEndpointAddress(url: URL, options?: ModelDiscoveryOptions) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Model endpoint hostname did not resolve");
  if (
    !options?.allowPrivateNetwork &&
    addresses.some(({ address, family: addressFamily }) =>
      blockedModelEndpointAddresses.check(address, addressFamily === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new Error("Private-network model endpoints require deployment-owner access");
  }
  return addresses[0]!;
}

async function requestModelEndpoint(
  url: URL,
  authorization: string | undefined,
  signal?: AbortSignal,
  options?: ModelDiscoveryOptions,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const resolved = await resolveModelEndpointAddress(url, options);
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
  return new Promise((resolve, reject) => {
    const servername = url.hostname.replace(/^\[|\]$/g, "");
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: resolved.address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername,
        headers: {
          accept: "application/json",
          host: url.host,
          ...(authorization ? { authorization } : {}),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MODEL_DISCOVERY_MAX_BYTES) {
            request.destroy(new Error("Model endpoint response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const abort = () => request.destroy(signal?.reason ?? new Error("Request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(MODEL_DISCOVERY_TIMEOUT_MS, () => {
      request.destroy(new Error("Model endpoint timed out"));
    });
    request.on("error", reject);
    request.on("close", () => signal?.removeEventListener("abort", abort));
    request.end();
  });
}

export function openaiCompatibleModel(
  provider: string,
  modelId: string,
  baseUrl: string,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
  };
}

export function attachOpenAICompatibleProvider(
  models: MutableModels,
  input: {
    provider: string;
    baseUrl: string;
    modelId: string;
    apiKey?: string;
    extraModelIds?: string[];
  },
): void {
  const baseUrl = normalizeOpenAICompatibleBaseUrl(input.baseUrl);
  const ids = [...new Set([input.modelId, ...(input.extraModelIds ?? [])].filter(Boolean))];
  models.setProvider(
    createProvider({
      id: input.provider,
      name: input.provider,
      baseUrl,
      auth: {
        apiKey: {
          name: "Custom endpoint",
          resolve: async () => ({
            auth: input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {},
          }),
        },
      },
      models: ids.map((id) => openaiCompatibleModel(input.provider, id, baseUrl)),
      api: openAICompletionsApi(),
    }),
  );
}
