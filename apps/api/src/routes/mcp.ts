import { ORPCError } from "@orpc/server";
import {
  lockMcpOAuthMaterial,
  McpOAuthClientRequiredError,
  persistPreparedSecret,
  recordMcpServerHealth,
  wakeRun,
} from "@rakazo/adapters";
import type { Actor, McpOAuthClientKind } from "@rakazo/contracts";
import { MCP_OAUTH_REDIRECT_MISMATCH, McpServerConfigInput } from "@rakazo/contracts";
import { ClientError, customMcpServerInput } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  assertNameFreeWhereAvailable,
  availableInSpace,
  IsolationError,
  isUniqueViolation,
  itemSecretIn,
  lockOwner,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  queueMcpConnectedRun,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "../integrations/mcp-approval.js";
import { buildMcpUpdateMaterial, legacyMcpArgs } from "../integrations/mcp-material.js";
import {
  assertMcpOAuthTemplates,
  assertMcpRemoteEndpoint,
  assertMcpStdioAdmin,
  assertMcpStdioCommand,
  MCP_OAUTH_PENDING_MESSAGE,
  mcpAssignmentDto,
  mcpServerDto,
} from "../integrations/mcp-servers.js";
import { serverAvailability, serverSecretSpace } from "../spaces/name-claims.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function mcpRoutes(ctx: RouterContext) {
  const {
    deps,
    onboardingDeps,
    mcpOAuth,
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
    authed,
  } = ctx;
  /** Gives the bot the server, closing any card that asked for it. */
  async function approveMcpAssignment(
    actor: Actor,
    input: { botId: string; serverId: string; threadId?: string },
  ) {
    const row = await resolveMcpApprovalCards(
      onboardingDeps,
      actor,
      {
        botId: input.botId,
        serverId: input.serverId,
        status: "connected",
        threadId: input.threadId,
      },
      async (tx, decision) => {
        if (!decision.assign) throw new IsolationError();
        const [bot, server] = await Promise.all([
          tx.bot.findFirst({
            where: { id: input.botId, spaceId: actor.spaceId },
            select: { id: true },
          }),
          tx.mcpServer.findFirst({
            where: { id: input.serverId, ...availableInSpace(actor), enabled: true },
            select: { id: true },
          }),
        ]);
        if (!bot || !server) throw new IsolationError();
        const assignment = await tx.botMcpServer.upsert({
          where: { botId_serverId: { botId: bot.id, serverId: server.id } },
          create: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            serverId: server.id,
            allowAllTools: true,
            allowedTools: [],
          },
          update: {},
        });
        const runId =
          input.threadId && decision.resolved
            ? await queueMcpConnectedRun(tx, actor, {
                botId: bot.id,
                serverId: server.id,
                threadId: input.threadId,
              })
            : null;
        return { assignment, runId };
      },
    );
    if (!row) throw new IsolationError();
    if (row.runId) await wakeRun(deps.jobs, row.runId);
    return mcpAssignmentDto(row.assignment);
  }

  /** Leaves the server with `botIds` alone among the member's active bots, reopening the cards
   * of any bot that loses it; returns those cards' events to send once the write commits. */
  async function chooseMcpServerBots(
    tx: Prisma.TransactionClient,
    actor: Actor,
    serverId: string,
    botIds: string[],
  ) {
    const owner = { spaceId: actor.spaceId, userId: actor.userId };
    const requested = [...new Set(botIds)];
    // Any bot in the Space can use the member's own servers, as assignments.replace allows.
    const bots = await tx.bot.findMany({
      where: { spaceId: owner.spaceId, id: { in: requested } },
      select: { id: true, archivedAt: true },
    });
    if (bots.length !== requested.length) throw new IsolationError();
    // A bot archived since the choice was loaded is no longer offered, so it gains nothing.
    const chosen = bots.filter((bot) => !bot.archivedAt).map((bot) => bot.id);
    // Archived bots are not offered to choose from, so their assignments stay for a restore.
    const previous = await tx.botMcpServer.findMany({
      where: { ...owner, serverId, bot: { archivedAt: null } },
      select: { botId: true },
    });
    // A bot named in the choice is never removed, even one restored since the read above.
    const removed = previous.map((row) => row.botId).filter((botId) => !requested.includes(botId));
    await tx.botMcpServer.deleteMany({ where: { ...owner, serverId, botId: { in: removed } } });
    await tx.botMcpServer.createMany({
      data: chosen.map((botId) => ({ ...owner, botId, serverId })),
      skipDuplicates: true,
    });
    return (
      await Promise.all(
        removed.map((botId) =>
          revertConnectedMcpApprovals(
            onboardingDeps,
            actor,
            { botId, serverId, status: "pending" },
            tx,
          ),
        ),
      )
    ).flat();
  }

  /** Adds a server for every bot, or for `botIds` alone when given, in one transaction. */
  async function createMcpServer(actor: Actor, config: McpServerConfigInput, botIds?: string[]) {
    const stored = await prepareMcpServer(actor, config);
    // A refused save drops the credential stored for it.
    const row = await persistPreparedSecret(deps.prisma, deps.secrets, stored ?? undefined, () =>
      deps.prisma.$transaction(async (tx) => {
        const row = await insertMcpServer(tx, actor, config, stored, {
          everywhere: true,
          allBots: !botIds,
        });
        // A new server has no assignments, so choosing reopens no cards.
        if (botIds) await chooseMcpServerBots(tx, actor, row.id, botIds);
        return row;
      }),
    ).catch((error: unknown) => {
      // The slug comes from the name, so this is a second server with the same name.
      if (isUniqueViolation(error))
        throw new ClientError("CONFLICT", "An MCP server with that name already exists.");
      throw error;
    });
    return announceMcpServer(row, actor);
  }

  /** Saves a server's settings and, when given, which bots can use it, in one transaction. */
  async function updateMcpServer(
    actor: Actor,
    input: { id: string; config: McpServerConfigInput } | { id: string; secret: string },
    access?: { allBots: boolean; botIds: string[] },
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { existing, existingSecret } = await deps.prisma.$transaction(async (tx) => {
        const existing = await tx.mcpServer.findFirst({
          where: {
            id: input.id,
            ...availableInSpace(actor),
          },
        });
        if (!existing) throw new IsolationError();
        const existingSecret = existing.secretId
          ? await tx.secret.findFirst({
              where: {
                id: existing.secretId,
                ...itemSecretIn(actor),
              },
            })
          : null;
        return { existing, existingSecret };
      });
      let existingMaterial: Record<string, unknown> = {};
      let malformedSecret = false;
      let loadFailure: unknown;
      if (existingSecret) {
        let plaintext: string | undefined;
        try {
          plaintext = await deps.secrets.load(existingSecret.ciphertext, existingSecret.id);
        } catch (failure) {
          // Kept for an endpoint change, which must not go ahead without knowing what to drop.
          loadFailure = failure;
        }
        if (plaintext !== undefined) {
          try {
            const value = JSON.parse(plaintext);
            if (value && typeof value === "object" && !Array.isArray(value))
              existingMaterial = value as Record<string, unknown>;
            else malformedSecret = true;
          } catch {
            /* Existing malformed secrets are replaced only when new credentials are
             * supplied, or dropped when the endpoint changes. */
            malformedSecret = true;
          }
        }
      }
      const config =
        "config" in input
          ? input.config
          : {
              slug: existing.slug,
              name: existing.name,
              description: existing.description,
              enabled: existing.enabled,
              verbatimResults: existing.verbatimResults,
              transport: existing.transport as "streamable_http" | "sse",
              endpoint: existing.endpoint!,
              headers: (existingMaterial.headers ?? {}) as Record<string, string>,
              secret: input.secret,
            };
      if (!("config" in input) && existing.transport === "stdio") {
        throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
      }
      const nextEndpoint = "endpoint" in config ? config.endpoint : null;
      // Spellings of one URL, such as with and without a trailing slash, are one endpoint.
      const endpointChanged =
        existing.endpoint &&
        nextEndpoint &&
        URL.canParse(existing.endpoint) &&
        URL.canParse(nextEndpoint)
          ? new URL(existing.endpoint).href !== new URL(nextEndpoint).href
          : existing.endpoint !== nextEndpoint;
      if (endpointChanged) {
        await assertMcpRemoteEndpoint(nextEndpoint, deps);
      }
      if (config.transport === "stdio") {
        await assertMcpStdioCommand(config.command, actor, deps);
        await assertMcpRemoteEndpoint(config.oauthClient?.authorizationServer, deps);
      } else if (existing.transport === "stdio") {
        await assertMcpStdioAdmin(actor, deps);
      }
      existingMaterial.args ??= legacyMcpArgs(existing.args);
      const built = buildMcpUpdateMaterial(existingMaterial, config, {
        clearOAuth: endpointChanged,
        endpointChanged,
        commandChanged: existing.command !== ("command" in config ? config.command : null),
      });
      // A malformed credential must not stay attached to a new endpoint.
      const update: typeof built =
        malformedSecret && endpointChanged && built.action === "keep"
          ? { action: "store", material: {} }
          : built;
      // Without the stored credential, a move or a new one would lose what it keeps; only
      // clearing it can go ahead.
      if (
        loadFailure !== undefined &&
        (endpointChanged || update.action === "store") &&
        !("clearCredential" in config && config.clearCredential)
      )
        throw loadFailure;
      if (update.action === "store" && config.transport === "stdio") {
        await assertMcpRemoteEndpoint(update.material.oauthClient?.authorization_server, deps);
        assertMcpOAuthTemplates(
          update.material.env ?? {},
          update.material.files ?? {},
          Boolean(update.material.oauthClient),
        );
      }
      const stored =
        update.action === "store" && Object.keys(update.material).length > 0
          ? await deps.secrets.put(
              JSON.stringify(update.material),
              computerContext(actor, "mcp", "mcp.update"),
            )
          : null;
      const clearing = update.action === "store" && Object.keys(update.material).length === 0;
      const row = await persistPreparedSecret(deps.prisma, deps.secrets, stored ?? undefined, () =>
        deps.prisma.$transaction(async (tx) => {
          // A rename claims a name; availability changes take that lock before the secret,
          // so this takes it first too and the two can never wait on each other.
          if (config.slug !== existing.slug) await lockOwner(tx, actor.userId, "names:mcpServer");
          await lockMcpOAuthMaterial(tx, input.id);
          const current = await tx.mcpServer.findFirst({
            where: {
              id: input.id,
              ...availableInSpace(actor),
            },
          });
          if (!current) throw new IsolationError();
          if (
            current.revision !== existing.revision ||
            current.secretId !== existing.secretId ||
            current.endpoint !== existing.endpoint
          )
            return null;
          if (current.secretId)
            await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${current.secretId} FOR UPDATE`;
          const secret = current.secretId
            ? await tx.secret.findFirst({
                where: {
                  id: current.secretId,
                  ...itemSecretIn(actor),
                },
              })
            : null;
          if (secret?.ciphertext !== existingSecret?.ciphertext) return null;
          if (config.slug !== current.slug)
            await assertNameFreeWhereAvailable(
              tx,
              "mcpServer",
              actor,
              config.slug,
              await serverAvailability(tx, current),
              current.id,
            );
          if (stored) {
            await tx.secret.create({
              data: {
                id: stored.id,
                userId: actor.userId,
                spaceId: await serverSecretSpace(tx, current),
                kind: "mcp",
                ciphertext: stored.ciphertext,
              },
            });
          }
          const updated = await tx.mcpServer.update({
            where: { id: existing.id },
            data: {
              slug: config.slug,
              name: config.name,
              description: config.description,
              transport: config.transport,
              endpoint: nextEndpoint,
              command: "command" in config ? config.command : null,
              args: [],
              hasArgs: update.action === "store" && Boolean(update.material.args?.length),
              env: ("env" in config
                ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                : {}) as Prisma.InputJsonValue,
              // Omitted files are kept in the material, so the keys follow it.
              ...(update.action === "store"
                ? {
                    files: Object.fromEntries(
                      Object.keys(update.material.files ?? {}).map((key) => [key, true]),
                    ) as Prisma.InputJsonValue,
                  }
                : {}),
              // A stored material can drop headers the update sent, so the keys follow it.
              headers: ("headers" in config
                ? Object.fromEntries(
                    Object.keys(
                      update.action === "store"
                        ? (update.material.headers ?? {})
                        : endpointChanged
                          ? Object.fromEntries(
                              Object.entries(config.headers).filter(([, value]) => value),
                            )
                          : config.headers,
                    ).map((key) => [key, true]),
                  )
                : {}) as Prisma.InputJsonValue,
              enabled: config.enabled,
              verbatimResults: config.verbatimResults,
              ...(access ? { allBots: access.allBots } : {}),
              revision: { increment: 1 },
              // The old verdict is about the old config.
              healthStatus: "unknown",
              healthMessage: null,
              healthToolCount: null,
              healthCheckedAt: null,
              ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
            },
          });
          if ((stored || clearing) && existing.secretId)
            await tx.secret.deleteMany({
              where: {
                id: existing.secretId,
                ...itemSecretIn(actor),
              },
            });
          // Under allBots the assignments stay as they were, so choosing agents again restores them.
          const seqs =
            access && !access.allBots
              ? await chooseMcpServerBots(tx, actor, existing.id, access.botIds)
              : [];
          return { updated, seqs };
        }),
      );
      if (row) {
        for (const event of row.seqs) await deps.events.notify(event.threadId, event.seq);
        const oauth = await mcpOAuth.summaryFor(row.updated, actor);
        return mcpServerDto(await beginMcpProbe(row.updated, actor, oauth), oauth);
      }
    }
    throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
  }

  /** Starts a sign-in on the registered web callback; `botId` gets the server once it finishes. */
  async function beginMcpOAuth(
    actor: Actor,
    input: {
      serverId: string;
      redirectUri?: string;
      client?: McpOAuthClientKind;
      botId?: string;
      capturesLoopback?: boolean;
    },
  ) {
    // The web origin, or an extra one the operator trusts (a phone reaching it over a tailnet).
    const allowedRedirects = [deps.env.webOrigin, ...(deps.env.extraAuthOrigins ?? [])].map(
      (origin) => new URL("/mcp/oauth/callback", origin).toString(),
    );
    const requested = input.redirectUri && new URL(input.redirectUri).toString();
    // Native clients omit the redirect; the registered web callback is used then.
    const expectedRedirect = requested || allowedRedirects[0]!;
    if (!allowedRedirects.includes(expectedRedirect)) {
      throw new ClientError(
        "BAD_REQUEST",
        "The sign-in address does not match this server's configuration.",
        MCP_OAUTH_REDIRECT_MISMATCH,
      );
    }
    try {
      return await mcpOAuth.begin({
        ...input,
        redirectUri: expectedRedirect,
        spaceId: actor.spaceId,
        userId: actor.userId,
      });
    } catch (error) {
      if (error instanceof McpOAuthClientRequiredError)
        await recordMcpServerHealth(
          deps.prisma,
          input.serverId,
          { status: "error", message: error.message },
          error.revision,
        );
      throw error;
    }
  }

  return {
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: availableInSpace(context.actor),
            include: { availableIn: AVAILABILITY_SELECT },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  ...itemSecretIn(context.actor),
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return Promise.all(
            rows.map(async (row) =>
              mcpServerDto(
                row,
                await mcpOAuth.summaryForCiphertext(
                  row.secretId ? ciphertextById.get(row.secretId) : undefined,
                  row.secretId ?? undefined,
                ),
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(({ context, input }) =>
          createMcpServer(context.actor, input),
        ),
        createForBots: authed.mcp.servers.createForBots.handler(({ context, input }) =>
          createMcpServer(context.actor, input.config, input.botIds),
        ),
        connect: authed.mcp.servers.connect.handler(async ({ context, input }) => {
          const { actor } = context;
          const config = McpServerConfigInput.parse(
            customMcpServerInput(input.name, input.endpoint),
          );
          // The same address in another form ("https://host/" for "https://host") is the same server.
          const endpoint = new URL(input.endpoint).href;
          const stored = await prepareMcpServer(actor, config);
          const { row, created } = await persistPreparedSecret(
            deps.prisma,
            deps.secrets,
            stored ?? undefined,
            () =>
              deps.prisma.$transaction(async (tx) => {
                // Two connects to the same new address share one server.
                await lockOwner(tx, actor.userId, "mcp-connect");
                const rows = await tx.mcpServer.findMany({
                  where: { ...availableInSpace(actor), enabled: true, endpoint: { not: null } },
                  include: { availableIn: AVAILABILITY_SELECT },
                  orderBy: { createdAt: "asc" },
                });
                const existing = rows.find(
                  (row) => URL.canParse(row.endpoint!) && new URL(row.endpoint!).href === endpoint,
                );
                if (existing) return { row: existing, created: false };
                return {
                  row: await insertMcpServer(tx, actor, config, stored, { everywhere: true }),
                  created: true,
                };
              }),
          );
          const server = created
            ? await announceMcpServer(row, actor)
            : mcpServerDto(row, await mcpOAuth.summaryFor(row, actor));
          const serverId = row.id;
          const signIn = await beginMcpOAuth(actor, {
            serverId,
            redirectUri: input.redirectUri,
            client: input.client,
            botId: input.botId,
            capturesLoopback: input.capturesLoopback,
          });
          if (signIn.status !== "authorization_required" && input.botId)
            await approveMcpAssignment(actor, { botId: input.botId, serverId });
          return { server, signIn };
        }),
        update: authed.mcp.servers.update.handler(({ context, input }) =>
          updateMcpServer(context.actor, input),
        ),
        /** A separate procedure, so a server too old to save access rejects it before saving the settings. */
        save: authed.mcp.servers.save.handler(({ context, input }) =>
          updateMcpServer(context.actor, input, input.access),
        ),
        test: authed.mcp.servers.test.handler(async ({ context, input }) => {
          const scope = { id: input.id, ...availableInSpace(context.actor) };
          const server = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!server) throw new IsolationError();
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          if (!deps.mcp) {
            await recordMcpServerHealth(
              deps.prisma,
              server.id,
              { status: "error", message: "This server cannot be checked from here." },
              server.revision,
            );
          } else if (await mcpAwaitsOAuth(server, context.actor, oauth)) {
            await recordMcpServerHealth(
              deps.prisma,
              server.id,
              { status: "unknown", message: MCP_OAUTH_PENDING_MESSAGE },
              server.revision,
            );
          } else {
            await probeMcpServer(server, context.actor);
          }
          const fresh = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!fresh) throw new IsolationError();
          return mcpServerDto(fresh, oauth);
        }),
        agents: authed.mcp.servers.agents.handler(async ({ context, input }) => {
          const owner = { spaceId: context.actor.spaceId, userId: context.actor.userId };
          const { server, assignments, seqs } = await deps.prisma.$transaction(async (tx) => {
            const existing = await tx.mcpServer.findFirst({
              where: { id: input.id, ...availableInSpace(context.actor) },
              select: { id: true },
            });
            if (!existing) throw new IsolationError();
            const server = await tx.mcpServer.update({
              where: { id: existing.id },
              data: { allBots: input.allBots },
              include: { availableIn: AVAILABILITY_SELECT },
            });
            // Under allBots the assignments stay as they were, so choosing agents again restores them.
            const seqs = input.allBots
              ? []
              : await chooseMcpServerBots(tx, context.actor, server.id, input.botIds);
            // As assignments.all reads them: an archived bot's row stays but is not listed.
            const assignments = await tx.botMcpServer.findMany({
              where: { ...owner, serverId: server.id, bot: { archivedAt: null } },
              orderBy: { createdAt: "asc" },
            });
            return { server, assignments, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          return {
            server: mcpServerDto(server, oauth),
            assignments: assignments.map(mcpAssignmentDto),
          };
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              ...availableInSpace(context.actor),
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          // Cards are closed first, including ones that were never assigned.
          const seqs = await deps.prisma.$transaction((tx) =>
            removeMcpServerInTransaction(tx, context.actor, server),
          );
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return { ok: true as const };
        }),
      },
      // Any bot in the space can use the member's own servers; servers and assignments stay personal.
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
              server: availableInSpace(context.actor),
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              server: availableInSpace(context.actor),
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(({ context, input }) =>
          approveMcpAssignment(context.actor, input),
        ),
        dismiss: authed.mcp.assignments.dismiss.handler(async ({ context, input }) => {
          // Not now resolves the card only. Assignments are never touched
          // here: a stale card must not delete a live connection, and server
          // removal belongs to the MCP settings surface.
          await resolveMcpApprovalCards(onboardingDeps, context.actor, {
            botId: input.botId,
            serverId: input.serverId,
            status: "dismissed",
            threadId: input.threadId,
          });
          return { ok: true as const };
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const { rows, seqs } = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                ...availableInSpace(context.actor),
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            const previous = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { serverId: true },
            });
            const nextIds = new Set(input.assignments.map((assignment) => assignment.serverId));
            const removed = previous
              .map((row) => row.serverId)
              .filter((serverId) => !nextIds.has(serverId));
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            const seqs = (
              await Promise.all(
                removed.map((serverId) =>
                  revertConnectedMcpApprovals(
                    onboardingDeps,
                    context.actor,
                    { botId: bot.id, serverId, status: "pending" },
                    tx,
                  ),
                ),
              )
            ).flat();
            const rows = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
            return { rows, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return rows.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(({ context, input }) =>
          beginMcpOAuth(context.actor, input),
        ),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          const { serverId, revision, botId } = await mcpOAuth.complete({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          // A check from before the sign-in would otherwise still read as failing. Only this
          // sign-in's revision: an edit since then has its own health and its own check.
          await recordMcpServerHealth(
            deps.prisma,
            serverId,
            { status: "unknown", message: null },
            revision,
          );
          // The account is connected now: check the server so it shows ok/error.
          void (async () => {
            const server = await deps.prisma.mcpServer.findFirst({
              where: { id: serverId, revision, ...availableInSpace(context.actor) },
            });
            if (server)
              await beginMcpProbe(
                server,
                context.actor,
                await mcpOAuth.summaryFor(server, context.actor),
              );
          })().catch((error) => getLogger().error("mcp server probe after oauth failed", error));
          // A bot removed since the sign-in began has nothing to get. Any other failure fails
          // the call: signing in again finds the server connected and gives it to the bot.
          if (botId)
            await approveMcpAssignment(context.actor, { botId, serverId }).catch((error) => {
              if (!(error instanceof IsolationError)) throw error;
            });
          return { ok: true as const };
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          const revision = await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          // A health check from before the disconnect would otherwise still read as connected.
          // Only this disconnect's revision: a sign-in since then has its own health.
          if (revision !== undefined)
            await recordMcpServerHealth(
              deps.prisma,
              input.serverId,
              { status: "unknown", message: MCP_OAUTH_PENDING_MESSAGE },
              revision,
            );
          return { ok: true as const };
        }),
      },
    },
  };
}
