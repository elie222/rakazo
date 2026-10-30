import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  createPluginMarketplace,
  isTransientFetchError,
  McpOAuthClientRequiredError,
  persistPreparedSecret,
  pluginPreviewDto,
  prepareApiInstall,
  prepareGraphqlInstall,
  previewPluginInstall,
  recordMcpServerHealth,
  sanitizeComposioError,
  verifyMcpInstall,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { signupSurveyAsksTeamSize } from "@rakazo/contracts";
import { comparePlugins, containsSecret, matchesPluginQuery } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  availableInSpace,
  IsolationError,
  itemSecretIn,
  spaceAvailability,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  assertNameFreeWhereAvailable,
  lockOwner,
  serverAvailability,
  serverSecretSpace,
} from "../availability.js";
import { searchIntegrationCatalog } from "../integration-catalog.js";
import {
  queueMcpConnectedRun,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "../mcp-approval.js";
import { buildMcpUpdateMaterial, legacyMcpArgs } from "../mcp-material.js";
import {
  assertMcpOAuthTemplates,
  assertMcpRemoteEndpoint,
  assertMcpStdioCommand,
  MCP_OAUTH_PENDING_MESSAGE,
  mayUsePrivateEndpoint,
  mcpAssignmentDto,
  mcpServerDto,
} from "../mcp-servers.js";
import {
  chooseFocus,
  dismissFocus,
  markAppConnected,
  promptFocus,
  startOnboarding,
} from "../onboarding.js";
import { installPlugin, lockPluginInstalls, setPluginParts } from "../plugin-installs.js";
import {
  approvedPluginEntries,
  isAdmin,
  listPluginSubmissions,
  reviewPluginSubmission,
} from "../plugin-submissions.js";
import type { RouterContext } from "./context.js";
import { computerContext, isUniqueViolation } from "./shared.js";

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
  const pluginMarketplace = createPluginMarketplace(deps.pluginMarketplaceRead);
  const requireAdmin = async (actor: Actor) => {
    if (!(await isAdmin(deps, actor.userId)))
      throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  };
  /** Removes an install and, for a plugin, the servers, secrets and skills it added. */
  const removeInstall = async (actor: Actor, id: string) => {
    const notify: Array<{ threadId: string; seq: number }> = [];
    await deps.prisma.$transaction(async (tx) => {
      // Parts changes hold this lock while adding children; reading them without it could
      // miss a connector committed meanwhile and leave its secret behind.
      await lockPluginInstalls(tx, actor);
      const existing = await tx.capabilityInstall.findFirst({
        where: { id, ...availableInSpace(actor) },
      });
      if (!existing) return;
      if (existing.kind === "plugin") {
        const servers = await tx.mcpServer.findMany({
          where: { installId: existing.id, userId: actor.userId },
          select: { id: true, secretId: true },
        });
        for (const server of servers) {
          notify.push(...(await removeMcpServerInTransaction(tx, actor, server)));
        }
        await tx.agentSkill.deleteMany({ where: { installId: existing.id } });
      }
      await tx.capabilityInstall.delete({ where: { id: existing.id } });
      if (existing.secretId) {
        const shared = await tx.capabilityInstall.count({
          where: { secretId: existing.secretId },
        });
        if (shared === 0) {
          await tx.secret.deleteMany({
            where: { id: existing.secretId, ...itemSecretIn(actor) },
          });
        }
      }
    });
    for (const event of notify) await deps.events.notify(event.threadId, event.seq);
  };
  return {
    marketplace: {
      catalog: authed.marketplace.catalog.handler(async ({ input }) => {
        const [catalog, approved] = await Promise.all([
          pluginMarketplace.catalog(input.query),
          approvedPluginEntries(deps.prisma),
        ]);
        // A plugin also listed by another registry shows once, as the version we reviewed.
        const reviewed = new Set(approved.map((entry) => entry.installedSource));
        return {
          ...catalog,
          entries: [
            ...approved.filter((entry) => matchesPluginQuery(entry, input.query)),
            ...catalog.entries.filter((entry) => !reviewed.has(entry.installedSource)),
          ].sort(comparePlugins),
        };
      }),
      submissions: authed.marketplace.submissions.handler(async ({ context, input }) => {
        await requireAdmin(context.actor);
        return listPluginSubmissions(deps.prisma, input.status);
      }),
      review: authed.marketplace.review.handler(async ({ context, input }) => {
        await requireAdmin(context.actor);
        return reviewPluginSubmission(deps, input, context.signal);
      }),
    },
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: availableInSpace(context.actor),
          include: { availableIn: AVAILABILITY_SELECT },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          availability: spaceAvailability(row),
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      catalogSearch: authed.capabilities.catalogSearch.handler(async ({ context, input }) => {
        const baseUrl =
          deps.env.integrationsCatalogUrl ??
          (input.usePublicCatalog ? "https://integrations.sh" : undefined);
        if (!baseUrl) return { enabled: false, results: [] };
        try {
          const results = await searchIntegrationCatalog({
            baseUrl,
            query: input.query,
            signal: context.signal ?? new AbortController().signal,
            fetch: deps.remoteConnectors?.fetch,
          });
          return { enabled: true, results };
        } catch (error) {
          throw new ORPCError("BAD_GATEWAY", {
            message: error instanceof Error ? error.message : "Integration catalog search failed",
          });
        }
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        if (input.kind === "plugin") {
          return installPlugin(
            {
              prisma: deps.prisma,
              secrets: deps.secrets,
              fetcher: deps.pluginRepoFetcher,
              assertEndpoint: (endpoint) => assertMcpRemoteEndpoint(endpoint, deps),
            },
            context.actor,
            input,
            context.signal,
          );
        }
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (
          credential &&
          input.kind !== "mcp" &&
          input.kind !== "api" &&
          input.kind !== "graphql"
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP, API, and GraphQL tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            if (config.preset === "treg") {
              source = "https://treg.to/mcp/";
              config = { ...config, preset: "treg", auth: { type: "bearer" } };
            }
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
          if (input.kind === "graphql") {
            const prepared = await prepareGraphqlInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeComposioError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            // A source the user adds reaches all their spaces, so its secret is the account's.
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: null,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              allSpaces: true,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          availability: spaceAvailability(row),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      pluginPreview: authed.capabilities.pluginPreview.handler(async ({ context, input }) => {
        try {
          const preview = await previewPluginInstall({
            source: input.source,
            signal: context.signal,
            fetcher: deps.pluginRepoFetcher,
          });
          for (const server of preview.mcpServers) {
            await assertMcpRemoteEndpoint(server.endpoint, deps);
          }
          // Browse lists only plugins that install completely; one that turns out partial leaves it.
          if (preview.skipped.some((part) => part.kind !== "unsupported_field"))
            pluginMarketplace.markUnreadable(input.source);
          else pluginMarketplace.clearUnreadable(input.source);
          return {
            ...pluginPreviewDto(preview),
            pinnedSource: `${preview.source.gitUrl}@${preview.resolvedSha}${preview.source.subdir ? `#${preview.source.subdir}` : ""}`,
            installedSource: `${preview.source.gitUrl}${preview.source.subdir ? `#${preview.source.subdir}` : ""}`,
          };
        } catch (error) {
          // Only content we can't support leaves browse; a slow or failing GitHub is retried.
          if (!isTransientFetchError(error)) pluginMarketplace.markUnreadable(input.source);
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not preview a supported plugin from this repository",
          });
        }
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await removeInstall(context.actor, input.id);
        return { ok: true as const };
      }),
      pluginParts: authed.capabilities.pluginParts.handler(async ({ context, input }) => {
        const notify: Array<{ threadId: string; seq: number }> = [];
        const install = await setPluginParts(
          {
            prisma: deps.prisma,
            secrets: deps.secrets,
            fetcher: deps.pluginRepoFetcher,
            assertEndpoint: (endpoint) => assertMcpRemoteEndpoint(endpoint, deps),
            removeServer: async (tx, server) =>
              notify.push(...(await removeMcpServerInTransaction(tx, context.actor, server))),
          },
          context.actor,
          input,
          context.signal,
        );
        for (const event of notify) await deps.events.notify(event.threadId, event.seq);
        if (!install) await removeInstall(context.actor, input.id);
        return { install };
      }),
    },
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
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          const stored = await prepareMcpServer(context.actor, input);
          const row = await deps.prisma
            .$transaction((tx) =>
              insertMcpServer(tx, context.actor, input, stored, { everywhere: true }),
            )
            .catch((error: unknown) => {
              // The slug comes from the name, so this is a second server with the same name.
              if (isUniqueViolation(error)) {
                throw new ORPCError("CONFLICT", {
                  message: "An MCP server with that name already exists.",
                });
              }
              throw error;
            });
          return announceMcpServer(row, context.actor);
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const { existing, existingSecret } = await deps.prisma.$transaction(async (tx) => {
              const existing = await tx.mcpServer.findFirst({
                where: {
                  id: input.id,
                  ...availableInSpace(context.actor),
                },
              });
              if (!existing) throw new IsolationError();
              const existingSecret = existing.secretId
                ? await tx.secret.findFirst({
                    where: {
                      id: existing.secretId,
                      ...itemSecretIn(context.actor),
                    },
                  })
                : null;
              return { existing, existingSecret };
            });
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  await deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
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
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    headers: (existingMaterial.headers ?? {}) as Record<string, string>,
                    secret: input.secret,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            if (existing.endpoint !== nextEndpoint) {
              await assertMcpRemoteEndpoint(nextEndpoint, deps);
            }
            if (config.transport === "stdio") {
              assertMcpStdioCommand(config.command, deps);
              await assertMcpRemoteEndpoint(config.oauthClient?.authorizationServer, deps);
            }
            const endpointChanged = existing.endpoint !== nextEndpoint;
            existingMaterial.args ??= legacyMcpArgs(existing.args);
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: endpointChanged,
              endpointChanged,
              commandChanged: existing.command !== ("command" in config ? config.command : null),
            });
            if (update.action === "store" && config.transport === "stdio") {
              await assertMcpRemoteEndpoint(
                update.material.oauthClient?.authorization_server,
                deps,
              );
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
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            const row = await persistPreparedSecret(
              deps.prisma,
              deps.secrets,
              stored ?? undefined,
              () =>
                deps.prisma.$transaction(async (tx) => {
                  // A rename claims a name; availability changes take that lock before the secret,
                  // so this takes it first too and the two can never wait on each other.
                  if (config.slug !== existing.slug)
                    await lockOwner(tx, context.actor.userId, "names:mcpServer");
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
                  const current = await tx.mcpServer.findFirst({
                    where: {
                      id: input.id,
                      ...availableInSpace(context.actor),
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
                          ...itemSecretIn(context.actor),
                        },
                      })
                    : null;
                  if (secret?.ciphertext !== existingSecret?.ciphertext) return null;
                  if (config.slug !== current.slug)
                    await assertNameFreeWhereAvailable(
                      tx,
                      "mcpServer",
                      context.actor,
                      config.slug,
                      await serverAvailability(tx, current),
                      current.id,
                    );
                  if (stored) {
                    await tx.secret.create({
                      data: {
                        id: stored.id,
                        userId: context.actor.userId,
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
                      headers: ("headers" in config
                        ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      enabled: config.enabled,
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
                        ...itemSecretIn(context.actor),
                      },
                    });
                  return updated;
                }),
            );
            if (row) {
              const oauth = await mcpOAuth.summaryFor(row, context.actor);
              return mcpServerDto(await beginMcpProbe(row, context.actor, oauth), oauth);
            }
          }
          throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
        }),
        test: authed.mcp.servers.test.handler(async ({ context, input }) => {
          const scope = { id: input.id, ...availableInSpace(context.actor) };
          const server = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!server) throw new IsolationError();
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          if (!deps.mcp) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "error",
              message: "This server cannot be checked from here.",
            });
          } else if (await mcpAwaitsOAuth(server, context.actor, oauth)) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "unknown",
              message: MCP_OAUTH_PENDING_MESSAGE,
            });
          } else {
            await probeMcpServer(server, context.actor);
          }
          const fresh = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!fresh) throw new IsolationError();
          return mcpServerDto(fresh, oauth);
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
              userId: context.actor.userId,
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
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await resolveMcpApprovalCards(
            onboardingDeps,
            context.actor,
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
                  where: {
                    id: input.botId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                  select: { id: true },
                }),
                tx.mcpServer.findFirst({
                  where: {
                    id: input.serverId,
                    ...availableInSpace(context.actor),
                    enabled: true,
                  },
                  select: { id: true },
                }),
              ]);
              if (!bot || !server) throw new IsolationError();
              const assignment = await tx.botMcpServer.upsert({
                where: { botId_serverId: { botId: bot.id, serverId: server.id } },
                create: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: server.id,
                  allowAllTools: true,
                  allowedTools: [],
                },
                update: {},
              });
              const runId =
                input.threadId && decision.resolved
                  ? await queueMcpConnectedRun(tx, context.actor, {
                      botId: bot.id,
                      serverId: server.id,
                      threadId: input.threadId,
                    })
                  : null;
              return { assignment, runId };
            },
          );
          if (!row) throw new IsolationError();
          if (row.runId) {
            // The queued run is durable; a missed wake is repaired by the reconciler.
            await deps.jobs.enqueue(runContinueJob(row.runId)).catch((error) => {
              getLogger().error("mcp connected enqueue", error);
            });
          }
          return mcpAssignmentDto(row.assignment);
        }),
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
                userId: context.actor.userId,
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
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            // Native clients omit the redirect; the registered web callback is always used.
            if (input.redirectUri && new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await mcpOAuth.begin({
              ...input,
              redirectUri: expectedRedirect,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            if (error instanceof McpOAuthClientRequiredError) {
              await recordMcpServerHealth(
                deps.prisma,
                input.serverId,
                { status: "error", message: error.message },
                error.revision,
              );
              throw new ORPCError(error.code, { status: 400, message: error.message });
            }
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            // complete() consumes the session, so which server it belongs to is read first.
            const session = deps.mcp
              ? await deps.prisma.mcpOAuthSession
                  .findFirst({
                    where: {
                      id: input.sessionId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                    select: { serverId: true },
                  })
                  .catch(() => null)
              : null;
            await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            if (session) {
              // The account is connected now: check the server so it shows ok/error.
              void (async () => {
                const server = await deps.prisma.mcpServer.findFirst({
                  where: {
                    id: session.serverId,
                    ...availableInSpace(context.actor),
                  },
                });
                if (server)
                  await beginMcpProbe(
                    server,
                    context.actor,
                    await mcpOAuth.summaryFor(server, context.actor),
                  );
              })().catch((error) =>
                getLogger().error("mcp server probe after oauth failed", error),
              );
            }
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          // A health check from before the disconnect would otherwise still read as connected.
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.serverId,
              ...availableInSpace(context.actor),
            },
            select: { id: true },
          });
          if (server)
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "unknown",
              message: MCP_OAUTH_PENDING_MESSAGE,
            });
          return { ok: true as const };
        }),
      },
    },
    onboarding: {
      signupSurvey: authed.onboarding.signupSurvey.handler(async ({ context, input }) => {
        const answers = {
          reason: input.reason || null,
          use: input.use ?? null,
          teamSize: signupSurveyAsksTeamSize(input.use) ? (input.teamSize ?? null) : null,
          source: input.source || null,
        };
        const saved = await deps.prisma.signupSurvey.upsert({
          where: { userId: context.actor.userId },
          create: { userId: context.actor.userId, ...answers },
          update: answers,
        });
        deps.analytics?.capture(
          context.actor.userId,
          {
            name: "signup_survey_answered",
            skipped: Object.values(answers).every((answer) => answer === null),
            ...(answers.use ? { use: answers.use } : {}),
            ...(answers.teamSize ? { teamSize: answers.teamSize } : {}),
          },
          // The first save's time keeps a resubmission a duplicate of the same event.
          { id: context.actor.userId, at: saved.createdAt },
        );
        return { ok: true as const };
      }),
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      promptFocus: authed.onboarding.promptFocus.handler(async ({ context, input }) => {
        await promptFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(onboardingDeps, context.actor, input.botId, input.optionId);
        return { ok: true as const };
      }),
      dismissFocus: authed.onboarding.dismissFocus.handler(async ({ context, input }) => {
        await dismissFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          onboardingDeps,
          context.actor,
          input.botId,
          input.provider,
          input.connectorId,
          input.threadId,
          input.messageId,
        );
        return { ok: true as const };
      }),
    },
    integrationSetup: {
      get: authed.integrationSetup.get.handler(() => ({
        canConfigure: false,
        needsSetup: false,
        webUrl: new URL("/integrations/setup", deps.env.webOrigin).toString(),
        providers: [],
      })),
      save: authed.integrationSetup.save.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
  };
}
