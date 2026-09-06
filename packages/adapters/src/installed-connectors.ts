import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  disambiguateInstalledToolNames,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import {
  assertSafeRemoteUrl,
  callRemoteMcpTool,
  createSafeRemoteFetch,
  listRemoteMcpTools,
  type RemoteTransportDependencies,
} from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

const HeaderValue = z.string().max(2_048);
const HeaderName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid HTTP header name")
  .refine((name) => !isTransportHeader(name), "Transport-level headers cannot be customized");
const ModelHeaderName = HeaderName.refine(
  (name) => !isSensitiveHeader(name),
  "Sensitive headers cannot be model-controlled",
);
const AuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header", "query"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

const McpAuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

const PublicHeadersSchema = z
  .record(z.string(), HeaderValue)
  .default({})
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (isSensitiveHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Sensitive header ${name} must use the encrypted credential field`,
        });
      } else if (isTransportHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Transport-level header ${name} cannot be customized`,
        });
      }
    }
  });

const McpConfigSchema = z.object({
  preset: z.enum(["treg", "custom"]).default("custom"),
  auth: McpAuthSchema,
  headers: PublicHeadersSchema,
});

const ApiOperationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/").max(2_048),
  inputSchema: z.record(z.string(), z.unknown()).default({
    type: "object",
    properties: {},
  }),
  readOnly: z.boolean().default(false),
  queryParameters: z.array(z.string().min(1).max(120)).default([]),
  headerParameters: z.array(ModelHeaderName).default([]),
});

const ApiConfigSchema = z.object({
  auth: AuthSchema,
  headers: PublicHeadersSchema,
  operations: z.array(ApiOperationSchema).min(1).max(100),
});

type ApiOperation = z.infer<typeof ApiOperationSchema>;
type InstalledRow = {
  id: string;
  kind: string;
  name: string;
  source: string;
  secretId: string | null;
  config: unknown;
};

export type RemoteConnectorDependencies = RemoteTransportDependencies;

export class InstalledConnectorProvider implements ConnectorProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly remote: RemoteConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "installed",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools("installed", "installed", "API", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const installs = await this.prisma.capabilityInstall.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        kind: { in: ["mcp", "api"] },
      },
      orderBy: { createdAt: "asc" },
    });
    const tools: ConnectorTool[] = [];
    for (let offset = 0; offset < installs.length; offset += 4) {
      const groups = await Promise.all(
        installs.slice(offset, offset + 4).map((install) => this.discoverInstall(install, context)),
      );
      tools.push(...groups.flat());
    }
    return disambiguateInstalledToolNames(tools);
  }

  private async discoverInstall(
    install: InstalledRow,
    context: AdapterContext,
  ): Promise<ConnectorTool[]> {
    const catalogGroup = catalogGroupLabel(install.name, install.kind, install.id);
    try {
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const credential = await this.loadCredential(install, context);
        const remote = await listRemoteMcpTools({
          endpoint: install.source,
          headers: connectorHeaders(config, credential),
          signal: context.signal,
          fetch: this.remote.fetch,
          resolveHostname: this.remote.resolveHostname,
        });
        return remote.map((tool) => ({
          ...tool,
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: tool.name,
            catalogGroup,
          },
        }));
      }
      if (install.kind === "api") {
        const config = ApiConfigSchema.parse(install.config);
        return config.operations.map((operation) => ({
          name: operation.name ?? operation.id,
          description: operation.description ?? `${operation.method} ${operation.path}`,
          inputSchema: operation.inputSchema,
          readOnly: operation.readOnly,
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: operation.id,
            catalogGroup,
          },
        }));
      }
    } catch {
      // One unavailable user-installed source must not hide the other tools.
    }
    return [];
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId === "installed" && isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const installId = call.route?.resourceId;
    if (!installId) {
      yield { type: "error", message: "Installed connector route is missing" };
      return;
    }
    const install = await this.prisma.capabilityInstall.findFirst({
      where: {
        id: installId,
        spaceId: context.spaceId,
        userId: context.userId,
        kind: { in: ["mcp", "api"] },
      },
    });
    if (!install) {
      yield { type: "error", message: "Installed connector is unavailable" };
      return;
    }
    let credential: string | undefined;
    try {
      credential = await this.loadCredential(install, context);
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const result = await callRemoteMcpTool(
          {
            endpoint: install.source,
            headers: connectorHeaders(config, credential),
            signal: context.signal,
            fetch: this.remote.fetch,
            resolveHostname: this.remote.resolveHostname,
          },
          call.route?.toolName ?? call.tool,
          call.args,
        );
        yield {
          type: "result",
          data: redactConnectorPayload(result, credential ? [credential] : []),
        };
        return;
      }
      const config = ApiConfigSchema.parse(install.config);
      const operation = config.operations.find(
        (candidate) => candidate.id === (call.route?.toolName ?? call.tool),
      );
      if (!operation) throw new Error("API operation is unavailable");
      const result = await executeApiOperation(
        install.source,
        config,
        operation,
        call.args,
        credential,
        context.signal,
        this.remote,
      );
      yield {
        type: "result",
        data: redactConnectorPayload(result, credential ? [credential] : []),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(error, credential ? [credential] : []),
      };
    }
  }

  private async loadCredential(
    install: Pick<InstalledRow, "secretId">,
    context: AdapterContext,
  ): Promise<string | undefined> {
    if (!install.secretId) return undefined;
    const row = await this.prisma.secret.findFirst({
      where: {
        id: install.secretId,
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    return row ? this.secrets.load(row.ciphertext, row.id) : undefined;
  }
}

export async function verifyMcpInstall(input: {
  source: string;
  config: unknown;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
}): Promise<{ config: Record<string, unknown>; toolCount: number }> {
  assertNoSensitiveQuery(input.source);
  const config = McpConfigSchema.parse(input.config);
  requireCredential(config.auth, input.credential);
  const tools = await listRemoteMcpTools({
    endpoint: input.source,
    headers: connectorHeaders(config, input.credential),
    signal: input.signal,
    fetch: input.remote?.fetch,
    resolveHostname: input.remote?.resolveHostname,
  });
  if (tools.length === 0) throw new Error("MCP server returned no tools");
  return { config, toolCount: tools.length };
}

export async function prepareApiInstall(input: {
  source: string;
  config: Record<string, unknown>;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
}): Promise<{ source: string; config: Record<string, unknown>; operationCount: number }> {
  const auth = AuthSchema.parse(input.config.auth);
  requireCredential(auth, input.credential);
  const headers = PublicHeadersSchema.parse(input.config.headers);
  assertNoSensitiveQuery(input.source);
  let source = input.source;
  let operationsValue = input.config.operations;
  if (input.config.openApi === true || input.config.openapi === true) {
    const documentUrl = new URL(input.source);
    const documentHeaders: Record<string, string> = { accept: "application/json", ...headers };
    applyCredential(documentUrl, documentHeaders, auth, input.credential);
    const document = await loadOpenApiDocument(
      documentUrl,
      documentHeaders,
      input.signal,
      input.remote,
    );
    const imported = importOpenApiDocument(document);
    source = imported.baseUrl;
    operationsValue = imported.operations;
  }
  await assertSafeRemoteUrl(source, input.remote?.resolveHostname);
  const config = ApiConfigSchema.parse({ auth, headers, operations: operationsValue });
  return {
    source,
    config,
    operationCount: config.operations.length,
  };
}

async function loadOpenApiDocument(
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
  remote: RemoteConnectorDependencies = {},
): Promise<Record<string, unknown>> {
  const safeFetch = createSafeRemoteFetch(remote.fetch ?? globalThis.fetch, remote.resolveHostname);
  try {
    const response = await safeFetch(url, {
      headers,
      signal: combineSignals(signal, AbortSignal.timeout(15_000)),
    });
    if (!response.ok) throw new Error(`OpenAPI document returned HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 2_000_000) throw new Error("OpenAPI document is too large");
    const { text, truncated } = await readBoundedText(response, 2_000_000);
    if (truncated) throw new Error("OpenAPI document is too large");
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export function importOpenApiDocument(document: Record<string, unknown>): {
  baseUrl: string;
  operations: ApiOperation[];
} {
  const server = Array.isArray(document.servers) ? document.servers[0] : undefined;
  const baseUrl =
    server && typeof server === "object" && typeof (server as { url?: unknown }).url === "string"
      ? String((server as { url: string }).url)
      : "";
  if (!baseUrl) throw new Error("OpenAPI document must define servers[0].url");
  assertNoSensitiveQuery(baseUrl);
  const paths = document.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new Error("OpenAPI document has no paths");
  }
  const operations: ApiOperation[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    if (!pathValue || typeof pathValue !== "object" || Array.isArray(pathValue)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const raw = (pathValue as Record<string, unknown>)[method];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const operation = raw as Record<string, unknown>;
      const id = typeof operation.operationId === "string" ? operation.operationId : undefined;
      if (!id) continue;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const queryParameters: string[] = [];
      const headerParameters: string[] = [];
      const commonParameters = Array.isArray((pathValue as Record<string, unknown>).parameters)
        ? ((pathValue as Record<string, unknown>).parameters as unknown[])
        : [];
      const ownParameters = Array.isArray(operation.parameters)
        ? (operation.parameters as unknown[])
        : [];
      for (const parameterValue of [...commonParameters, ...ownParameters]) {
        if (!parameterValue || typeof parameterValue !== "object") continue;
        const parameter = parameterValue as Record<string, unknown>;
        if (typeof parameter.name !== "string") continue;
        properties[parameter.name] = asRecord(parameter.schema) ?? { type: "string" };
        if (parameter.in === "query") queryParameters.push(parameter.name);
        if (parameter.in === "header") {
          if (isSensitiveHeader(parameter.name) || isTransportHeader(parameter.name)) {
            throw new Error(`OpenAPI operation ${id} contains unsafe header ${parameter.name}`);
          }
          headerParameters.push(parameter.name);
        }
        if (parameter.required === true) required.push(parameter.name);
      }
      const requestBody = asRecord(operation.requestBody);
      const content = asRecord(requestBody?.content);
      const jsonBody = asRecord(content?.["application/json"]);
      const bodySchema = asRecord(jsonBody?.schema);
      if (bodySchema) {
        properties.body = bodySchema;
        if (requestBody?.required === true) required.push("body");
      }
      operations.push({
        id,
        name: id,
        description:
          typeof operation.description === "string"
            ? operation.description
            : typeof operation.summary === "string"
              ? operation.summary
              : `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase() as ApiOperation["method"],
        path,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
        },
        readOnly: method === "get",
        queryParameters,
        headerParameters,
      });
      if (operations.length >= 100) break;
    }
    if (operations.length >= 100) break;
  }
  if (operations.length === 0) {
    throw new Error("OpenAPI document has no operations with operationId");
  }
  return { baseUrl, operations };
}

function connectorHeaders(
  config: z.infer<typeof McpConfigSchema>,
  credential?: string,
): Record<string, string> {
  const headers = { ...config.headers };
  if (!credential || config.auth.type === "none") return headers;
  const name = config.auth.type === "header" ? config.auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = config.auth.type === "bearer" ? `Bearer ${credential}` : credential;
  return headers;
}

async function executeApiOperation(
  baseUrl: string,
  config: z.infer<typeof ApiConfigSchema>,
  operation: ApiOperation,
  args: Record<string, unknown>,
  credential: string | undefined,
  signal: AbortSignal,
  remote: RemoteConnectorDependencies,
): Promise<unknown> {
  const consumed = new Set<string>();
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    if (value == null) throw new Error(`Missing path parameter ${name}`);
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  const url = joinApiUrl(baseUrl, path);
  const headers: Record<string, string> = { accept: "application/json", ...config.headers };
  let body: string | undefined;
  for (const key of operation.headerParameters) {
    const value = args[key];
    consumed.add(key);
    if (value != null) headers[key] = String(value);
  }
  if (operation.method === "GET" || operation.method === "DELETE") {
    for (const [key, value] of Object.entries(args)) {
      if (consumed.has(key) || value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (typeof value !== "object") {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    for (const key of operation.queryParameters) {
      const value = args[key];
      consumed.add(key);
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const payload =
      args.body ?? Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key)));
    body = JSON.stringify(payload);
    headers["content-type"] = "application/json";
  }
  applyCredential(url, headers, config.auth, credential);
  const safeFetch = createSafeRemoteFetch(remote.fetch ?? globalThis.fetch, remote.resolveHostname);
  try {
    const response = await safeFetch(url, {
      method: operation.method,
      headers,
      body,
      signal: combineSignals(signal, AbortSignal.timeout(30_000)),
    });
    const { text, truncated } = await readBoundedText(response, 1_000_000);
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Keep non-JSON API responses as bounded text.
    }
    if (!response.ok) {
      return {
        error: true,
        status: response.status,
        data,
        ...(truncated ? { truncated: true } : {}),
      };
    }
    return { status: response.status, data, ...(truncated ? { truncated: true } : {}) };
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

function joinApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/${path.replace(/^\//, "")}`;
  base.search = "";
  base.hash = "";
  return base;
}

function requireCredential(auth: z.infer<typeof AuthSchema>, credential?: string): void {
  if (auth.type !== "none" && !credential) throw new Error("This connector requires a credential");
}

function applyCredential(
  url: URL,
  headers: Record<string, string>,
  auth: z.infer<typeof AuthSchema>,
  credential?: string,
): void {
  if (!credential || auth.type === "none") return;
  if (auth.type === "query") {
    if (!auth.name) throw new Error("Authentication query name is required");
    url.searchParams.set(auth.name, credential);
    return;
  }
  const name = auth.type === "header" ? auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = auth.type === "bearer" ? `Bearer ${credential}` : credential;
}

function isSensitiveHeader(name: string): boolean {
  return /(authorization|cookie|api[-_]?key|token|secret)/i.test(name);
}

function isTransportHeader(name: string): boolean {
  return /^(connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i.test(
    name,
  );
}

function assertNoSensitiveQuery(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Connector URL is invalid");
  }
  for (const name of url.searchParams.keys()) {
    if (/(auth|credential|key|password|secret|token)/i.test(name)) {
      throw new Error(`Connector URL must put ${name} in the encrypted credential field`);
    }
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const remaining = maximumBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      await reader.cancel().catch(() => undefined);
      // Do not flush an incomplete sequence at the byte boundary: TextDecoder
      // would turn it into U+FFFD instead of returning the valid UTF-8 prefix.
      return { text, truncated: true };
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
