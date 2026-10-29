import { implement, ORPCError } from "@orpc/server";
import {
  applyCodexLiveCatalog,
  applyProviderLiveCatalog,
  CHATGPT_OAUTH_PROVIDER,
  CodexCatalogCache,
  codexLiveCatalogsForSpace,
  connectionServesModel,
  createFaviconResolver,
  decisionModelCatalog,
  deploymentModelRole,
  findConnectedModelCredential,
  hiddenCatalogModel,
  kickModelCredentialRefresh,
  listAvailablePiCatalog,
  McpOAuthBroker,
  modelCredentialAuthKindsForSpace,
  offeredCatalog,
  providerCatalogCache,
  providerLiveCatalogsForSpace,
  savedCatalogSelections,
  scriptedCatalogEntry,
  validateConnectedModelChoice,
} from "@rakazo/adapters";
import type {
  Actor,
  ModelCatalogEntry,
  ModelRole,
  ModelRoleChoice,
  ModelRoleSettings,
  ModelRoleView,
} from "@rakazo/contracts";
import {
  appContract,
  canonicalPiProviderId,
  modelSupportsRole,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { createGroupRepos, createRepos, recordSecurityEvent, runAsTenant } from "@rakazo/db";
import { createAgentImportServices } from "../agent-import-services.js";
import { createAgentSkillsService } from "../agent-skills.js";
import { createBotRemoval } from "../bot-removal.js";
import { createMcpServers } from "../mcp-servers.js";
import { createModelConnector, prepareAllowedThinkingLevels } from "../model-credentials.js";
import type { RouterDeps } from "../router.js";
import { createRoutineAnnouncer } from "../routines.js";
import { procedureSecurityEvent } from "../security-audit.js";
import { createTaughtSkillsService } from "../taught-skills.js";
import { meDto } from "./shared.js";

/**
 * Runs an authenticated procedure with row-level security scoped to the actor's
 * Space. A streamed result is read after the procedure returns, so each step of
 * its iterator re-enters the same scope.
 */
export async function asTenant<T extends { output: unknown }>(
  actor: Actor,
  next: () => T | PromiseLike<T>,
): Promise<T> {
  const result = await runAsTenant(actor, next);
  const output = result.output;
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
  const iterator = output as AsyncIterator<unknown> & AsyncIterable<unknown>;
  const scoped: AsyncIterableIterator<unknown> = {
    next: (...args) => runAsTenant(actor, () => iterator.next(...args)),
    return: (value) =>
      runAsTenant(actor, () => iterator.return?.(value) ?? { done: true as const, value }),
    throw: (error) =>
      runAsTenant(actor, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
    [Symbol.asyncIterator]() {
      return scoped;
    },
  };
  return { ...result, output: scoped };
}

export function createRouterContext(deps: RouterDeps) {
  const os = implement(appContract).$context<{
    actor: Actor | null;
    /** The signed-in session, so a push token ends with the session that registered it. */
    sessionId?: string;
    signal?: AbortSignal;
    /** Re-runs the request's auth so a long-lived stream notices sign-out and revocation. */
    stillAuthorized?: () => Promise<boolean>;
  }>();
  const repos = createRepos(deps.prisma, {
    phoneCallsEnabled: deps.env?.phoneCallsEnabled,
    phoneCallRingSeconds: deps.env?.phoneCallRingSeconds,
  });
  const onboardingDeps = { prisma: deps.prisma, events: deps.events, connectors: deps.connectors };
  const mcpOAuth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  const {
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
  } = createMcpServers(deps, onboardingDeps, mcpOAuth);
  const announceRoutine = createRoutineAnnouncer(deps);
  const codexCatalog = deps.codexCatalog ?? new CodexCatalogCache();
  const { verifyModelConnection, connectModelCredential } = createModelConnector(
    deps,
    codexCatalog,
  );
  const favicons = deps.favicons ?? createFaviconResolver();
  const refreshExpiredCredential =
    deps.refreshExpiredModelCredential ??
    ((scope: { userId: string; spaceId: string }, secretId: string, provider: string) =>
      kickModelCredentialRefresh(deps.prisma, deps.secrets, scope, secretId, provider));
  const botModelValidation = (actor: Actor) => ({
    prisma: deps.prisma,
    secretStore: deps.secrets,
    codexCatalog,
    refreshExpiredCredential,
    hostedProvider: deps.billing?.modelCreditsEnabled ? deps.env.defaultProvider : undefined,
    defaultModel: async () => {
      const me = await meDto(deps, actor);
      return { provider: me.defaultProvider, model: me.defaultModel };
    },
  });
  const removeBot = createBotRemoval(deps, repos);
  const agentImportServices = createAgentImportServices({
    deps,
    repos,
    codexCatalog,
    verifyModelConnection,
    botModelValidation,
    prepareMcpServer,
    insertMcpServer,
    announceRoutine,
  });
  // The scripted fixture only exists to drive the scripted runtime; a real runtime
  // cannot execute it, so it stays out of the user-facing catalog otherwise.
  const chatCatalog = async (actor: Actor) => {
    const catalog = await catalogForSpace(actor);
    return deps.env.agentRuntime === "scripted" ? [...catalog, scriptedCatalogEntry] : catalog;
  };
  const catalogForSpace = async (actor: Actor) => {
    const auth = await modelCredentialAuthKindsForSpace(
      deps.prisma,
      deps.secrets,
      actor,
      deps.billing?.modelCreditsEnabled ? deps.env.defaultProvider : undefined,
    );
    const available = listAvailablePiCatalog(auth.byProvider, auth.byModel);
    const [live, providerLive] = await Promise.all([
      codexLiveCatalogsForSpace(deps.prisma, deps.secrets, actor, auth, codexCatalog, {
        // An expired bearer yields no catalog this round; kick the runtime's
        // locked refresh so the next read can see the account's real list.
        onExpiredToken: (secretId) =>
          refreshExpiredCredential(actor, secretId, CHATGPT_OAUTH_PROVIDER),
      }),
      providerLiveCatalogsForSpace(
        deps.prisma,
        deps.secrets,
        actor,
        auth,
        deps.providerCatalog ?? providerCatalogCache,
      ),
    ]);
    const codexMerged = live.size > 0 ? applyCodexLiveCatalog(available, auth, live) : available;
    let selected = providerLive.size
      ? await savedCatalogSelections(deps.prisma, actor.userId)
      : undefined;
    const merged = applyProviderLiveCatalog(codexMerged, auth, providerLive, selected);
    // A connected provider's saved choice stays listed after new users stop being offered it.
    if (
      !selected &&
      merged.some(
        (entry) =>
          (auth.byProvider[entry.provider] ||
            auth.byModel[entry.provider] ||
            entry.provider === auth.managedProvider) &&
          hiddenCatalogModel(entry),
      )
    )
      selected = await savedCatalogSelections(deps.prisma, actor.userId);
    return offeredCatalog(merged, selected).map((entry) =>
      entry.provider === auth.managedProvider
        ? {
            ...entry,
            managed: true,
            billing:
              auth.secretIdByModel[entry.provider]?.[entry.id] ||
              auth.secretIdByProvider[entry.provider]
                ? entry.billing
                : "Uses Rakazo credits",
          }
        : entry,
    );
  };

  // Shown where a member chose no model, so the list names what actually runs.
  const withDeploymentDefault = async (
    role: ModelRole,
    settings: ModelRoleSettings,
  ): Promise<ModelRoleView> => {
    const defaults =
      role === "main"
        ? {
            settings: await deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
            // Only a model the deployment can run stands in for the member's choice.
            deployment: deps.env.deploymentModelConfigured
              ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
              : null,
          }
        : { env: process.env };
    return { ...settings, deploymentPrimary: deploymentModelRole(role, defaults).primary };
  };
  const modelRoleCatalog = async (actor: Actor, role: ModelRole): Promise<ModelCatalogEntry[]> => {
    const catalog = await chatCatalog(actor);
    const decisions = role === "approval" ? decisionModelCatalog() : [];
    const managedProviders = new Set(
      catalog.filter((entry) => "managed" in entry && entry.managed).map((entry) => entry.provider),
    );
    return withServingConnections(
      actor,
      [
        ...catalog,
        ...decisions.map((entry) => ({ ...entry, managed: managedProviders.has(entry.provider) })),
      ].filter((entry) => modelSupportsRole(entry, role)),
    );
  };
  /**
   * The space's catalog merges what any of a provider's connections can run. Where two
   * accounts differ (one ChatGPT plan lists a model the other does not), each entry names
   * the connections that can run it.
   */
  const withServingConnections = async (
    actor: Actor,
    catalog: ModelCatalogEntry[],
  ): Promise<ModelCatalogEntry[]> => {
    const connections = await deps.prisma.userModelCredential.findMany({
      where: { userId: actor.userId },
      select: { id: true, provider: true, secretId: true },
    });
    const byProvider = new Map<string, typeof connections>();
    for (const connection of connections) {
      const provider = canonicalPiProviderId(connection.provider);
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), connection]);
    }
    return Promise.all(
      catalog.map(async (entry) => {
        const owners = byProvider.get(canonicalPiProviderId(entry.provider)) ?? [];
        // Funded models run on the deployment's key, whichever connection is chosen, and
        // decision models run through the provider's decisions API on any of its keys.
        if (
          owners.length < 2 ||
          entry.placeholder ||
          entry.protocol === "decisions" ||
          ("managed" in entry && entry.managed)
        )
          return entry;
        const serving: string[] = [];
        for (const owner of owners)
          if (
            await connectionServesModel(servingDeps, actor.userId, owner, entry.provider, entry.id)
          )
            serving.push(owner.id);
        return serving.length === owners.length ? entry : { ...entry, credentialIds: serving };
      }),
    );
  };
  const servingDeps = { prisma: deps.prisma, secretStore: deps.secrets, codexCatalog };
  /** The connection serving each choice (null when deployment-managed), the one runs use. */
  const validateRoleChoices = async (
    actor: Actor,
    role: ModelRole,
    choices: ModelRoleChoice[],
  ): Promise<void> => {
    if (choices.length === 0) return;
    const catalog = await modelRoleCatalog(actor, role);
    for (const choice of choices) {
      const entry = catalog.find(
        (entry) =>
          entry.provider === canonicalPiProviderId(choice.provider) && entry.id === choice.modelId,
      );
      // A row pinned to a connection runs only there, never on the deployment's.
      const resolution = { credentialId: choice.credentialId };
      const credential = await findConnectedModelCredential(
        deps.prisma,
        deps.secrets,
        actor,
        choice.provider,
        choice.modelId,
        resolution,
      );
      if (!credential && (choice.credentialId || !(entry && "managed" in entry && entry.managed)))
        throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
      // Another account of the provider listing the model does not make it run on this one;
      // the catalog names the connections that can, as the picker shows.
      if (
        credential &&
        choice.credentialId &&
        entry?.credentialIds &&
        !entry.credentialIds.includes(choice.credentialId)
      )
        throw new ORPCError("BAD_REQUEST", {
          message: "That model is not available for this connection",
        });
      if (choice.thinkingLevel) {
        const { allowed } = await prepareAllowedThinkingLevels(
          deps,
          actor,
          choice.provider,
          choice.modelId,
          resolution,
        );
        if (allowed && !allowed.includes(choice.thinkingLevel))
          throw new ORPCError("BAD_REQUEST", {
            message: `Thinking level must be one of: ${allowed.join(", ")}`,
          });
      }
      if (entry && !entry.placeholder && choice.provider !== OPENAI_COMPATIBLE_PROVIDER_ID)
        continue;
      const error = await validateConnectedModelChoice(
        deps.prisma,
        deps.secrets,
        actor,
        choice.provider,
        choice.modelId,
        resolution,
      );
      if (error || choice.provider !== OPENAI_COMPATIBLE_PROVIDER_ID)
        throw new ORPCError("BAD_REQUEST", {
          message: error ?? "That model is not available for this connection",
        });
    }
  };
  const groupRepos = createGroupRepos(deps.prisma);
  const taughtSkills = createTaughtSkillsService({
    prisma: deps.prisma,
    events: deps.events,
    jobs: deps.jobs,
    sandbox: deps.sandbox,
    home: deps.home,
    dataDir: deps.dataDir,
  });
  const agentSkills = createAgentSkillsService(deps.prisma);

  const authed = os
    .use(async ({ context, next }) => {
      const actor = context.actor;
      if (!actor) throw new ORPCError("UNAUTHORIZED");
      return asTenant(actor, () => next({ context: { ...context, actor } }));
    })
    .use(async ({ context, next, path }, input) => {
      const result = await next();
      const event = procedureSecurityEvent(path, input, context.actor);
      if (event) await recordSecurityEvent(event);
      return result;
    });

  const callsEnabled = authed.use(async ({ next }) => {
    if (!deps.env?.phoneCallsEnabled) throw new ORPCError("NOT_FOUND");
    return next();
  });

  const boardEnabled = os
    .use(async ({ next }) => {
      if (!deps.env?.ticketBoardEnabled) throw new ORPCError("NOT_FOUND");
      return next();
    })
    .use(async ({ context, next }) => {
      const actor = context.actor;
      if (!actor) throw new ORPCError("UNAUTHORIZED");
      return asTenant(actor, () => next({ context: { ...context, actor } }));
    });
  const ticketDeps = {
    prisma: deps.prisma,
    ticketBoardEnabled: deps.env?.ticketBoardEnabled,
    onTicketChange: deps.ticketChanges,
  };

  return {
    deps,
    os,
    repos,
    onboardingDeps,
    mcpOAuth,
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
    announceRoutine,
    codexCatalog,
    connectModelCredential,
    favicons,
    refreshExpiredCredential,
    botModelValidation,
    removeBot,
    agentImportServices,
    chatCatalog,
    withDeploymentDefault,
    modelRoleCatalog,
    validateRoleChoices,
    groupRepos,
    taughtSkills,
    agentSkills,
    authed,
    callsEnabled,
    boardEnabled,
    ticketDeps,
  };
}

export type RouterContext = ReturnType<typeof createRouterContext>;
