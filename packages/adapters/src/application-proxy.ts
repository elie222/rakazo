import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { resolveEncryptionKey } from "@rakazo/core/node/secrets-guard";
import { runAsTenant } from "@rakazo/db";
import { z } from "zod";
import type { ApplicationServices, ConnectedApplication } from "./configured-apps.js";
import { connectedContext } from "./connection-context.js";
import { readBoundedText } from "./connector-http.js";
import { ConnectorRegistry } from "./connector-registry.js";

const MAX_BYTES = 1_000_000;
const id = z.string().min(1).max(200);
const route = z.strictObject({
  connectorId: id,
  toolName: id,
  resourceId: id.optional(),
  resourceRevision: z.union([id, z.number()]).optional(),
  connectionId: id.optional(),
  catalogGroup: z.string().max(2_000).optional(),
});
const call = z.strictObject({
  tool: id,
  executionId: id,
  args: z.record(z.string(), z.unknown()),
  connectionId: id.optional(),
  route: route.optional(),
});
const context = z.strictObject({
  userId: id,
  spaceId: id,
  botId: id,
  runId: id,
  operationId: id,
  traceId: id,
  connectionIds: z.array(id).max(2_000),
});
const input = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("discover"), context }),
  z.strictObject({ action: z.literal("resolve"), context, call }),
  z.strictObject({ action: z.literal("execute"), context, call }),
]);

/** Purpose-separated from both session signing and device forwarding; never a login credential. */
export function applicationForwardSecret(env: Record<string, string | undefined>): string {
  return createHmac("sha256", resolveEncryptionKey(env))
    .update("rakazo:application-forward:v1")
    .digest("hex");
}

/** Workers forward tool calls, never user tokens or authentication configuration. */
export class ApplicationProxyConnector implements ConnectorProvider {
  private readonly base: URL;
  private readonly authorization: string;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly id: string,
    env: Record<string, string | undefined>,
    private readonly fetcher = globalThis.fetch,
  ) {
    try {
      this.base = new URL(env.APP_INTERNAL_URL || "http://127.0.0.1:3100");
      if (
        !["http:", "https:"].includes(this.base.protocol) ||
        this.base.username ||
        this.base.password ||
        this.base.pathname !== "/" ||
        this.base.search ||
        this.base.hash
      )
        throw new Error();
    } catch {
      throw new Error("Invalid APP_INTERNAL_URL configuration");
    }
    this.authorization = `Bearer ${applicationForwardSecret(env)}`;
  }
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }
  close() {
    this.shutdown.abort();
  }
  private async request<T>(
    action: "discover" | "resolve" | "execute",
    context: AdapterContext,
    call?: ConnectorCall,
  ): Promise<T> {
    const body = JSON.stringify({
      action,
      context: {
        userId: context.userId,
        spaceId: context.spaceId,
        botId: context.botId,
        runId: context.runId,
        operationId: context.operationId,
        traceId: context.traceId,
        connectionIds:
          context.connectedConnections
            ?.filter((row) => row.connectorId === this.id)
            .map((row) => row.id) ?? [],
      },
      ...(call ? { call } : {}),
    });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Application request too large");
    try {
      const response = await this.fetcher(
        new URL(`/internal/apps/${encodeURIComponent(this.id)}`, this.base),
        {
          method: "POST",
          redirect: "manual",
          headers: { authorization: this.authorization, "content-type": "application/json" },
          body,
          signal: AbortSignal.any([
            context.signal,
            this.shutdown.signal,
            AbortSignal.timeout(60_000),
          ]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const result = await readBoundedText(response, MAX_BYTES);
      if (result.truncated) throw new Error();
      return JSON.parse(result.text).value as T;
    } catch {
      throw new Error("Connected application unavailable");
    }
  }
  discoverTools(context: AdapterContext) {
    return this.request<ConnectorTool[]>("discover", context);
  }
  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    return (
      (await this.request<{ call: ConnectorCall; tool: ConnectorTool } | null>(
        "resolve",
        context,
        call,
      )) ?? undefined
    );
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    // No transport retry: an uncertain paid request retains its persisted operation identity.
    const events = await this.request<ConnectorEvent[]>("execute", context, call);
    for (const event of events) yield event;
  }
}

/** Authenticated internal transport only. No URLs, headers or credentials are caller-controlled. */
export async function handleApplicationRequest(
  services: ApplicationServices,
  apps: ConnectedApplication[],
  request: Request,
  id: string,
): Promise<Response> {
  const app = apps.find((app) => app.connector.describe().id === id);
  if (!app || !services.credentials) return new Response(null, { status: 404 });
  const expected = Buffer.from(`Bearer ${applicationForwardSecret(services.env)}`);
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    return new Response(null, { status: 401 });
  try {
    const body = await readBoundedText(new Response(request.body), MAX_BYTES);
    if (body.truncated) return new Response(null, { status: 413 });
    const parsed = input.safeParse(JSON.parse(body.text));
    if (!parsed.success || ("call" in parsed.data && parsed.data.call.route?.connectorId !== id))
      return new Response(null, { status: 400 });
    const operation = parsed.data;
    return await runAsTenant(operation.context, async () => {
      const { prisma } = services;
      const run = await prisma.run.findFirst({
        where: {
          id: operation.context.runId,
          userId: operation.context.userId,
          spaceId: operation.context.spaceId,
          botId: operation.context.botId,
          status: "running",
          leaseExpiresAt: { gt: new Date() },
        },
      });
      const member = await prisma.spaceMember.findUnique({
        where: {
          spaceId_userId: {
            userId: operation.context.userId,
            spaceId: operation.context.spaceId,
          },
        },
      });
      if (!run || !member) return new Response(null, { status: 403 });
      const rows = await prisma.connection.findMany({
        where: {
          id: { in: operation.context.connectionIds },
          connectorId: id,
          userId: run.userId,
          spaceId: run.spaceId,
          status: "connected",
        },
      });
      if (rows.length !== new Set(operation.context.connectionIds).size)
        return new Response(null, { status: 403 });
      const context: AdapterContext = {
        ...operation.context,
        ...connectedContext(rows),
        signal: request.signal,
      };
      const connector = new ConnectorRegistry([app.connector]);
      let value: unknown;
      if (operation.action === "discover") value = await connector.discoverTools(context);
      else if (operation.action === "resolve")
        value = (await connector.resolveCall(operation.call, context)) ?? null;
      else {
        const events: ConnectorEvent[] = [];
        for await (const event of connector.execute(operation.call, context)) {
          events.push(event);
          if (events.length > 100) throw new Error();
        }
        value = events;
      }
      const output = JSON.stringify({ value });
      return Buffer.byteLength(output) <= MAX_BYTES
        ? new Response(output, { headers: { "content-type": "application/json" } })
        : new Response(null, { status: 502 });
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
