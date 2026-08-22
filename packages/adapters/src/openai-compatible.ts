import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export const GATEWAY_PROVIDER_PREFIX = "gateway:";
export const OPENAI_COMPATIBLE_KEYLESS_API_KEY = "rakazo-keyless-no-auth-placeholder";
const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_MAX_BYTES = 1_000_000;
const MODEL_LIST_MAX_ENTRIES = 200;
const MODEL_ID_MAX_LENGTH = 200;
const MAX_REDIRECTS = 5;

export interface GatewayNetworkOptions {
  allowPrivateNetwork?: boolean;
  hasCredentials?: boolean;
  timeoutMs?: number;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
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
    throw new Error("Base URL must not include credentials");
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

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
  options: GatewayNetworkOptions = {},
): Promise<string[]> {
  const endpoint = `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  const response = await createOpenAICompatibleFetch({
    ...options,
    timeoutMs: options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS,
  })(endpoint, { headers, signal });
  if (!response.ok) {
    throw new Error(`Could not list models (${response.status})`);
  }
  const body = JSON.parse(await readLimitedText(response, MODEL_LIST_MAX_BYTES)) as {
    data?: unknown;
    models?: unknown;
  };
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const ids = rows.slice(0, MODEL_LIST_MAX_ENTRIES).flatMap((row) => {
    const id =
      typeof row === "string"
        ? row
        : row && typeof row === "object" && "id" in row && typeof row.id === "string"
          ? row.id
          : "";
    const normalized = id.trim();
    return normalized && normalized.length <= MODEL_ID_MAX_LENGTH ? [normalized] : [];
  });
  if (!ids.length) throw new Error("That endpoint did not return any models");
  return [...new Set(ids)];
}

/**
 * Build a fetch implementation that validates and pins DNS for every gateway
 * request and redirect. Private endpoints are reserved for the deployment
 * owner; public endpoints must use TLS.
 */
export function createOpenAICompatibleFetch(options: GatewayNetworkOptions = {}): typeof fetch {
  return async (input, init) => {
    const initial = new Request(input, init);
    let url = new URL(initial.url);
    let method = initial.method;
    const headers = new Headers(initial.headers);
    if (headers.get("authorization") === `Bearer ${OPENAI_COMPATIBLE_KEYLESS_API_KEY}`) {
      headers.delete("authorization");
    }
    headers.set("accept-encoding", "identity");
    let body = method === "GET" || method === "HEAD" ? undefined : await initial.arrayBuffer();
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 300_000);
    const signal = AbortSignal.any([initial.signal, timeoutSignal]);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const addresses = await resolveAllowedAddresses(url, options.allowPrivateNetwork === true);
      assertCredentialTransport(url, addresses, headers.has("authorization"));
      const response = await requestPinned(url, { method, headers, body, signal }, addresses);
      const location = response.headers.get("location");
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error("Gateway redirected too many times");
      }

      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      await response.body?.cancel();
      url = nextUrl;
    }
    throw new Error("Gateway redirected too many times");
  };
}

export async function assertOpenAICompatibleBaseUrlAllowed(
  baseUrl: string,
  options: GatewayNetworkOptions = {},
): Promise<string> {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const url = new URL(normalized);
  const addresses = await resolveAllowedAddresses(url, options.allowPrivateNetwork === true);
  assertCredentialTransport(url, addresses, options.hasCredentials === true);
  return normalized;
}

export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined || octets.length !== 4) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const value = parseIpv6(address);
  if (value === null) return false;
  // Currently allocated globally routable unicast space is 2000::/3. Keep the
  // documentation prefix non-routable even though it sits inside that range.
  return inIpv6Cidr(value, 0x2000n << 112n, 3) && !inIpv6Cidr(value, 0x20010db8n << 96n, 32);
}

async function resolveAllowedAddresses(url: URL, allowPrivateNetwork: boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway URL must use http or https");
  }
  if (url.username || url.password) throw new Error("Gateway URL must not include credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses: ResolvedAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : ((await lookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[]);
  if (!addresses.length) throw new Error("Gateway host did not resolve");
  if (
    addresses.some(
      (entry) =>
        !isGloballyRoutableAddress(entry.address) && !isAllowedPrivateAddress(entry.address),
    )
  ) {
    throw new Error("Gateway host resolves to a prohibited network address");
  }
  const hasPrivateAddress = addresses.some((entry) => isAllowedPrivateAddress(entry.address));
  if (hasPrivateAddress && !allowPrivateNetwork) {
    throw new Error("Gateway host resolves to a private or local network address");
  }
  if (
    url.protocol !== "https:" &&
    addresses.some((entry) => isGloballyRoutableAddress(entry.address))
  ) {
    throw new Error("Public gateway URLs must use HTTPS");
  }
  return addresses;
}

function isAllowedPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family !== 6) return false;
  const value = parseIpv6(address);
  return value === 1n || (value !== null && inIpv6Cidr(value, 0xfcn << 120n, 7));
}

function assertCredentialTransport(
  url: URL,
  addresses: ResolvedAddress[],
  hasCredentials: boolean,
): void {
  if (
    hasCredentials &&
    url.protocol !== "https:" &&
    addresses.some((entry) => !isLoopbackAddress(entry.address))
  ) {
    throw new Error("Gateway credentials require HTTPS unless the endpoint is loopback");
  }
}

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  return parseIpv6(address) === 1n;
}

async function requestPinned(
  url: URL,
  input: {
    method: string;
    headers: Headers;
    body?: ArrayBuffer;
    signal: AbortSignal;
  },
  addresses: ResolvedAddress[],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
        signal: input.signal,
        lookup: pinnedLookup(addresses),
        // Never reuse a socket validated under a different user's network policy.
        agent: false,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const mayHaveBody =
          input.method !== "HEAD" && ![204, 205, 304].includes(incoming.statusCode ?? 0);
        if (!mayHaveBody) incoming.resume();
        resolve(
          new Response(
            mayHaveBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null,
            {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    request.once("error", reject);
    if (input.body?.byteLength) request.write(Buffer.from(input.body));
    request.end();
  });
}

function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const matching = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (!matching.length) {
      const error = Object.assign(new Error("Gateway address family did not resolve"), {
        code: "ENOTFOUND",
      });
      callback(error, "");
      return;
    }
    if (typeof options === "object" && options.all) callback(null, matching);
    else callback(null, matching[0]!.address, matching[0]!.family);
  };
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Model list is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Model list is too large");
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function parseIpv6(address: string): bigint | null {
  const withoutZone = address.split("%")[0]!;
  const pieces = withoutZone.split("::");
  if (pieces.length > 2) return null;
  const expandSide = (side: string): number[] | null => {
    if (!side) return [];
    const output: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const bytes = part.split(".").map(Number);
        if (
          bytes.length !== 4 ||
          bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
        ) {
          return null;
        }
        output.push(bytes[0]! * 256 + bytes[1]!, bytes[2]! * 256 + bytes[3]!);
      } else {
        const value = Number.parseInt(part, 16);
        if (!/^[0-9a-f]{1,4}$/i.test(part) || !Number.isFinite(value)) return null;
        output.push(value);
      }
    }
    return output;
  };
  const left = expandSide(pieces[0]!);
  const right = expandSide(pieces[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;
  const hextets = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (hextets.length !== 8) return null;
  return hextets.reduce((result, hextet) => (result << 16n) | BigInt(hextet), 0n);
}

function inIpv6Cidr(address: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return address >> shift === prefix >> shift;
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
