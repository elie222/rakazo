import { randomUUID } from "node:crypto";
import { createRouterClient, ORPCError } from "@orpc/server";
import { SandboxUnavailableError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import type { Actor, Bot, ServiceRouteDefinition, ServiceRouteId } from "@rakazo/contracts";
import { SERVICE_API_PREFIX, SERVICE_BODY_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  recordAuditEvent,
  runAsTenant,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import type { createRouter } from "./router.js";
import type { ServiceContext, ServiceErrorCode } from "./service-api-routes.js";
import {
  SERVICE_ERRORS,
  SERVICE_HANDLERS,
  SERVICE_ROUTE_TABLE,
  ServiceRejection,
} from "./service-api-routes.js";
import {
  authenticateServiceCredential,
  isServiceCredentialLive,
  SERVICE_REQUESTS_PER_MINUTE,
} from "./service-credentials.js";
import {
  bindIdempotencyKey,
  claimIdempotencyKey,
  finishIdempotencyKey,
  holdIdempotencyKey,
  IDEMPOTENCY_HOLD_SECONDS,
  releaseIdempotencyKey,
  requestHash,
} from "./service-idempotency.js";
import { SERVICE_MCP_PATH, serviceMcpHandler } from "./service-mcp.js";
import { claimStream } from "./service-streams.js";

export { projectBlocks } from "./service-api-routes.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

type Issue = { path: PropertyKey[]; message: string };
function fieldsOf(issues: readonly Issue[]) {
  return issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function parseQuery(url: URL, definition: ServiceRouteDefinition): unknown {
  const names = [...url.searchParams.keys()];
  if (new Set(names).size !== names.length) throw new ServiceRejection("invalid_request");
  // Postgres cannot store or compare a NUL, so it would surface as a server error.
  if ([...url.searchParams.values()].some((value) => value.includes("\0"))) {
    throw new ServiceRejection("invalid_request");
  }
  if (!definition.query) {
    if (names.length) throw new ServiceRejection("invalid_request");
    return undefined;
  }
  const parsed = definition.query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new ServiceRejection("invalid_request", fieldsOf(parsed.error.issues));
  }
  return parsed.data;
}

async function readBody(
  request: Request,
  definition: ServiceRouteDefinition,
): Promise<{ raw: string; value: unknown }> {
  if (definition.method === "GET") return { raw: "", value: undefined };
  const raw = await readBoundedBody(request, definition.maxBodyBytes ?? SERVICE_BODY_MAX_BYTES);
  if (raw === null) throw new ServiceRejection("payload_too_large");
  if (!definition.body) {
    if (raw.trim() && raw.trim() !== "{}") throw new ServiceRejection("invalid_request");
    return { raw, value: undefined };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new ServiceRejection("unsupported_media_type");
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ServiceRejection("invalid_request");
  }
  const parsed = definition.body.safeParse(input);
  if (!parsed.success) throw new ServiceRejection("invalid_request", fieldsOf(parsed.error.issues));
  return { raw, value: parsed.data };
}

export function rejectionOf(error: unknown): ServiceRejection {
  if (error instanceof ServiceRejection) return error;
  if (error instanceof IsolationError) return new ServiceRejection("not_found");
  if (error instanceof SpaceDeletionInProgressError) return new ServiceRejection("conflict");
  if (error instanceof SandboxUnavailableError || error instanceof SandboxUnresponsiveError) {
    return new ServiceRejection("service_unavailable");
  }
  if (error instanceof ORPCError) {
    const byCode: Record<string, ServiceErrorCode> = {
      NOT_FOUND: "not_found",
      BAD_REQUEST: "invalid_request",
      // The app refused the person, not the key: a scope cannot fix it.
      FORBIDDEN: "not_permitted",
      UNAUTHORIZED: "unauthenticated",
      TOO_MANY_REQUESTS: "rate_limited",
      CONFLICT: "conflict",
      PRECONDITION_FAILED: "conflict",
    };
    const code = byCode[String(error.code)];
    if (code === "invalid_request" || code === "conflict" || code === "not_permitted") {
      return new ServiceRejection(code, undefined, error.message);
    }
    if (code) return new ServiceRejection(code);
  }
  return new ServiceRejection("service_unavailable");
}

/** Well inside the five-minute hold, so one missed renewal does not release a running write. */
const IDEMPOTENCY_RENEW_MS = 60_000;

export function serviceApiHandler(deps: {
  prisma: PrismaClient;
  router: ReturnType<typeof createRouter>;
  /** The creator's current membership, or null once it is gone. */
  memberActor: (userId: string, spaceId: string) => Promise<Actor | null>;
}) {
  const { prisma, router, memberActor } = deps;
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const headers: Record<string, string> = { "x-request-id": requestId };
    try {
      const url = new URL(request.url);
      const path = url.pathname.slice(SERVICE_API_PREFIX.length) || "/";
      const matches = SERVICE_ROUTE_TABLE.flatMap((entry) => {
        const match = entry.pattern.exec(path);
        return match ? [{ ...entry, params: { ...match.groups } }] : [];
      });
      if (matches.length === 0) throw new ServiceRejection("not_found");

      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const credential = token ? await authenticateServiceCredential(prisma, token) : null;
      if (!credential) throw new ServiceRejection("unauthenticated");
      headers["x-ratelimit-limit"] = String(SERVICE_REQUESTS_PER_MINUTE);
      headers["x-ratelimit-remaining"] = String(credential.remaining);
      headers["x-ratelimit-reset"] = String(credential.resetSeconds);
      if (!credential.withinLimit) {
        headers["retry-after"] = String(credential.resetSeconds);
        throw new ServiceRejection("rate_limited");
      }

      const matched = matches.find((entry) => entry.definition.method === request.method);
      if (!matched) {
        headers.allow = [...new Set(matches.map((entry) => entry.definition.method))].join(", ");
        // The scope is checked first, so a key learns nothing about routes it may not use.
        const needed = matches[0]?.definition.scope;
        if (needed && !credential.scopes.includes(needed)) throw new ServiceRejection("forbidden");
        throw new ServiceRejection("method_not_allowed");
      }
      const definition: ServiceRouteDefinition = matched.definition;
      if (definition.scope && !credential.scopes.includes(definition.scope)) {
        throw new ServiceRejection("forbidden");
      }
      if (definition.spaceWide && credential.botIds.length) {
        throw new ServiceRejection("bot_limited_key");
      }

      const suppliedKey = request.headers.get("idempotency-key");
      if (definition.idempotency) {
        if (!suppliedKey || !IDEMPOTENCY_KEY.test(suppliedKey)) {
          throw new ServiceRejection("idempotency_key_required");
        }
      } else if (suppliedKey !== null) {
        // Silently ignoring it would let a caller believe a retry is safe when it is not.
        throw new ServiceRejection("invalid_request");
      }
      const query = parseQuery(url, definition);
      const { raw, value: body } = await readBody(request, definition);

      // Checked every request: a key never outlasts its creator's place in the space.
      const actor = await memberActor(credential.userId, credential.spaceId);
      if (!actor) throw new ServiceRejection("unauthenticated");
      const abort = new AbortController();
      request.signal.addEventListener("abort", () => abort.abort(), { once: true });
      const client = createRouterClient(router, {
        context: {
          actor,
          signal: abort.signal,
          serviceOrigin: { credentialId: credential.id, name: credential.name },
          stillAuthorized: async () =>
            (await isServiceCredentialLive(prisma, credential.id)) &&
            Boolean(await memberActor(credential.userId, credential.spaceId)),
        },
      });

      return await runAsTenant(actor, async () => {
        let bot: Bot | null = null;
        const botId = matched.params.botId;
        // One 404 for a bot that is absent, archived, someone else's or off this key's list.
        if (botId && credential.botIds.length && !credential.botIds.includes(botId)) {
          throw new ServiceRejection("not_found");
        }

        // Before the archive check, so a retry of a write that finished replays its answer even
        // if the bot has been archived since.
        const hash = requestHash(request.method, url.pathname, raw);
        const storedKey = definition.idempotency === "stored" ? suppliedKey : null;
        if (storedKey) {
          const claim = await claimIdempotencyKey(prisma, actor, credential.id, storedKey, hash);
          if (claim.kind === "conflict") throw new ServiceRejection("idempotency_conflict");
          if (claim.kind === "in_progress") {
            headers["retry-after"] = String(IDEMPOTENCY_HOLD_SECONDS);
            throw new ServiceRejection("idempotency_in_progress");
          }
          if (claim.kind === "replay") {
            return json(claim.status, claim.body, { ...headers, "idempotent-replayed": "true" });
          }
        }
        // A native write's message or run deduplicates a retry, but only for the same target.
        let boundKey: string | null = null;
        if (definition.idempotency === "native" && suppliedKey) {
          const bound = await bindIdempotencyKey(prisma, actor, credential.id, suppliedKey, hash);
          if (bound === "conflict") throw new ServiceRejection("idempotency_conflict");
          if (bound === "bound") boundKey = suppliedKey;
        }
        // A long write keeps its claim, so a retry cannot run it a second time meanwhile.
        const hold = storedKey
          ? setInterval(() => {
              void holdIdempotencyKey(prisma, credential.id, storedKey).catch((error) =>
                getLogger().warn("service_api.idempotency_hold_failed", error),
              );
            }, IDEMPOTENCY_RENEW_MS)
          : undefined;

        try {
          if (botId && !definition.allowArchived) {
            bot = await client.bots.get({ botId });
            if (bot.archivedAt) throw new ServiceRejection("not_found");
          }
          const context = {
            request,
            abort,
            client,
            prisma,
            actor,
            credential,
            params: matched.params,
            query,
            body,
            idempotencyKey: suppliedKey ?? "",
            bot,
            openStream: async () => {
              const release = await claimStream(prisma, actor, credential.id);
              if (!release) throw new ServiceRejection("too_many_streams");
              return release;
            },
          } as ServiceContext<ServiceRouteId>;
          const handler = SERVICE_HANDLERS[matched.id] as (
            context: ServiceContext<ServiceRouteId>,
          ) => Promise<unknown>;
          const output = await handler(context);
          if (output instanceof Response) {
            for (const [name, value] of Object.entries(headers)) output.headers.set(name, value);
            return output;
          }
          // An allowlist as well as a type: a field added upstream never reaches a key by accident.
          const projected = definition.response.parse(output);
          if (definition.method !== "GET" && !definition.selfAudited) {
            // Name what changed: the bot, else the group or ticket in the path, else what was made.
            const { botId: _bot, ...pathIds } = matched.params;
            const [pathName, pathId] = Object.entries(pathIds)[0] ?? [];
            const createdId =
              projected && typeof projected === "object" && "id" in projected
                ? String(projected.id)
                : undefined;
            await recordAuditEvent({
              action: `service_api.${matched.id}`,
              actor: { type: "service", id: credential.id, label: credential.name },
              spaceId: actor.spaceId,
              target: botId
                ? { type: "bot", id: botId, label: bot?.name ?? botId }
                : pathName
                  ? { type: pathName.replace(/Id$/, ""), id: pathId, label: definition.path }
                  : createdId && matched.id.startsWith("create")
                    ? {
                        type: matched.id.slice(6).toLowerCase(),
                        id: createdId,
                        label: definition.path,
                      }
                    : { type: "service_api", id: matched.id, label: definition.path },
              metadata: {
                onBehalfOf: actor.userId,
                ...pathIds,
                ...(createdId && createdId !== (botId ?? pathId) ? { createdId } : {}),
              },
            });
          }
          if (storedKey) {
            await finishIdempotencyKey(prisma, credential.id, storedKey, 200, projected);
          }
          return json(200, projected, headers);
        } catch (error) {
          // A refused write did nothing, so its key is free. An unknown outcome keeps its hold.
          const freed = storedKey ?? boundKey;
          if (freed && rejectionOf(error).code !== "service_unavailable") {
            await releaseIdempotencyKey(prisma, credential.id, freed);
          }
          throw error;
        } finally {
          clearInterval(hold);
        }
      });
    } catch (error) {
      const rejection = rejectionOf(error);
      if (rejection.code === "service_unavailable") getLogger().error("service_api.failed", error);
      const [status, message] = SERVICE_ERRORS[rejection.code];
      if (status === 401) headers["www-authenticate"] = "Bearer";
      return json(
        status,
        {
          error: {
            code: rejection.code,
            message: rejection.detail ?? message,
            ...(rejection.fields ? { fields: rejection.fields } : {}),
          },
        },
        headers,
      );
    }
  };
}

export function mountServiceApi(app: Hono, deps: Parameters<typeof serviceApiHandler>[0]): void {
  const handler = serviceApiHandler(deps);
  const mcp = serviceMcpHandler(handler);
  app.all(SERVICE_MCP_PATH, (c) => mcp(c.req.raw));
  app.all(SERVICE_API_PREFIX, (c) => handler(c.req.raw));
  app.all(`${SERVICE_API_PREFIX}/*`, (c) => handler(c.req.raw));
}
