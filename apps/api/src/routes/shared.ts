import { ORPCError } from "@orpc/server";
import type { SavedDeploymentModel } from "@rakazo/adapters";
import {
  adminDeploymentModel,
  deploymentModelRole,
  findConnectedModelCredential,
  hasHostedModelCredits,
  hostCredentialSource,
  mcpStdioAvailable,
  resolveMemberMainModel,
  sandboxKindCapabilities,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, Me } from "@rakazo/contracts";
import {
  attachmentMaxBytes,
  attachmentMaxCount,
  ChatPreferencesSchema,
  canonicalPiProviderId,
  LAB_FEATURES,
  modelCreditsUsd,
  resolveBotAvatarSet,
  resolveLabs,
} from "@rakazo/contracts";
import { chatPreferencesSelect } from "@rakazo/db";
import { isAdmin } from "../auth/admins.js";
import { effectiveSandboxProvider } from "../computers/computer-provider-config.js";
import type { RouterDeps } from "../router.js";

export { createAdapterContext as computerContext } from "@rakazo/adapter-kit";

function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup, admin, meetingsEnabled] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: {
        email: true,
        name: true,
        timezone: true,
        locale: true,
        botAvatarSet: true,
        ...chatPreferencesSelect,
        labs: true,
        signupSurvey: { select: { userId: true } },
      },
    }),
    modelSetup(deps, actor),
    isAdmin(deps, actor.userId),
    deps.meetings?.visible(actor),
  ]);
  // Where the deployment runs computers once an admin's choice in Settings applies.
  const sandboxProvider = effectiveSandboxProvider(setup.settings, deps.env.sandboxProvider);
  const deploymentLabs = deps.env.deploymentLabs ?? [];
  const labs = resolveLabs(user.labs, deploymentLabs);
  return {
    labs,
    labsAvailable: LAB_FEATURES.filter((feature) => !deploymentLabs.includes(feature)),
    ticketBoardEnabled: labs.includes("board"),
    meetingsEnabled,
    inboundOrigin: deps.env.publishedInboundOrigin,
    phoneCallsEnabled: deps.env.phoneCallsEnabled === true,
    navLinks: deps.env.navLinks ?? [],
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    maxAttachmentsPerMessage: attachmentMaxCount(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: false,
    isAdmin: admin,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(setup.model?.provider ?? deps.env.defaultProvider),
    defaultModel: setup.model?.modelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.main &&
        !adminDeploymentModel(setup.settings) &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    computerHost: computerHostFor(setup.settings?.computerHost, sandboxProvider),
    canChooseHostComputer:
      Boolean(deps.env.desktopHostChoiceEnabled) &&
      sandboxKindCapabilities(sandboxProvider).offersHostComputer === true,
    // The deployment's provider: an account's own choice covers only its Team Computers.
    sandboxProvider,
    computerSettingsEnabled: Boolean(deps.env.computerSettingsEnabled),
    mcpStdioEnabled:
      admin &&
      mcpStdioAvailable({
        stdioEnabled: deps.env.mcpStdioEnabled,
        allowedCommands: deps.env.mcpStdioAllowedCommands,
      }),
    avatarStyle: "organic",
    botAvatarSet: resolveBotAvatarSet(user.botAvatarSet),
    chatPreferences: ChatPreferencesSchema.parse(user),
    timezone: user.timezone ?? null,
    locale: user.locale ?? null,
    billingEnabled: Boolean(deps.billing),
    // Only billing deployments ask; self-hosted installs never see the survey.
    needsSignupSurvey: Boolean(deps.billing) && !user.signupSurvey,
    paymentWalletProvider: deps.paymentWallet
      ? { id: deps.paymentWallet.describe().id, name: deps.paymentWallet.displayName }
      : null,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (!sandboxKindCapabilities(sandboxProvider).offersHostComputer) return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

/** Whether this member can use the deployment's model under the current funding mode. */
export async function deploymentModelAccess(
  deps: RouterDeps,
  actor: Actor,
  settings: SavedDeploymentModel | null,
) {
  const funding = deps.billing ? await deps.billing.status(actor) : null;
  const creditsAvailable = modelCreditsUsd(funding) !== null;
  return {
    creditsAvailable,
    hasDeployment:
      (Boolean(deps.env.deploymentModelConfigured) || Boolean(adminDeploymentModel(settings))) &&
      (!funding?.creditPurchasesEnabled || creditsAvailable),
  };
}

/** The main model chat runs: the member's while it can run, else the deployment's. */
export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [member, settings] = await Promise.all([
    resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const main =
    member &&
    (member.credential ||
      (deps.billing?.modelCreditsEnabled &&
        (await hasHostedModelCredits(deps.prisma, actor, member.provider))))
      ? member
      : null;
  const deploymentAccess = await deploymentModelAccess(deps, actor, settings);
  return {
    main,
    model:
      main ??
      deploymentModelRole("main", {
        settings,
        deployment: { provider: deps.env.defaultProvider, model: deps.env.defaultModel },
      }).primary,
    settings,
    ...deploymentAccess,
    needsModel: deps.env.agentRuntime !== "scripted" && !main && !deploymentAccess.hasDeployment,
  };
}

/** Whether every bot runs its own model on one of the member's connections, as a run selects it. */
export async function botsRunOwnModels(deps: RouterDeps, actor: Actor, botIds: string[]) {
  const bots = await deps.prisma.bot.findMany({
    where: { id: { in: botIds }, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const credentials = await Promise.all(
    bots.map(async (bot) => {
      const overrideCredential = bot.modelProvider
        ? await findConnectedModelCredential(
            deps.prisma,
            deps.secrets,
            actor,
            bot.modelProvider,
            bot.modelId,
          )
        : null;
      return selectConfiguredModel({ override: bot, overrideCredential, main: null, defaults: {} })
        .credential;
    }),
  );
  return credentials.every(Boolean);
}

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;

export const HEARTBEAT = Symbol("heartbeat");

const ENDED = Symbol("ended");

/**
 * Yields each event from `follow`, or HEARTBEAT after HEARTBEAT_MS of silence: a half-open stream
 * looks identical to an idle one, and clients treat any frame as liveness. Auth ran once when the
 * stream opened, so before yielding anything this re-checks the session if SESSION_RECHECK_MS has
 * passed; a signed-out or revoked session ends the stream with UNAUTHORIZED.
 *
 * `forward` returns false for an event the client must not see. That event still re-checks the
 * session, but it is not a frame, so it does not restart the silence window. The window runs from
 * the pull after the previous frame. Time spent in `forward` counts against what is left; past the
 * deadline, this pull yields a heartbeat before another event is read.
 */
export async function* withHeartbeats<T>(
  context: { signal?: AbortSignal; stillAuthorized?: () => Promise<boolean> },
  follow: (signal: AbortSignal) => AsyncGenerator<T>,
  forward?: (item: T) => boolean | Promise<boolean>,
): AsyncGenerator<T | typeof HEARTBEAT> {
  const controller = new AbortController();
  const source = follow(
    context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
  );
  let pending: Promise<IteratorResult<T>> | undefined;
  let authorizedAt = Date.now();
  // Unset once a frame is yielded, so the next wait measures a full HEARTBEAT_MS from that pull.
  let heartbeatDueAt: number | undefined;
  try {
    while (!context.signal?.aborted) {
      heartbeatDueAt ??= Date.now() + HEARTBEAT_MS;
      const waitMs = heartbeatDueAt - Date.now();
      let next: IteratorResult<T> | typeof HEARTBEAT | typeof ENDED;
      if (waitMs <= 0) {
        next = HEARTBEAT;
      } else {
        // A heartbeat keeps `pending`, so the in-flight read stays the next event in order.
        pending ??= source.next();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        next = await Promise.race([
          pending,
          // Racing the abort ends a source that ignores it, so its session re-checks can't run after
          // shutdown has closed the database pool. The waiter is per read so a settled race, and the
          // event it carried, isn't retained until disconnect.
          new Promise<typeof HEARTBEAT | typeof ENDED>((resolve) => {
            timer = setTimeout(() => resolve(HEARTBEAT), waitMs);
            if (context.signal?.aborted) return resolve(ENDED);
            onAbort = () => resolve(ENDED);
            context.signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]).finally(() => {
          clearTimeout(timer);
          if (onAbort) context.signal?.removeEventListener("abort", onAbort);
        });
      }
      if (next === ENDED || context.signal?.aborted) return;
      if (context.stillAuthorized && Date.now() - authorizedAt >= SESSION_RECHECK_MS) {
        if (!(await context.stillAuthorized())) throw new ORPCError("UNAUTHORIZED");
        authorizedAt = Date.now();
      }
      if (next === HEARTBEAT) {
        heartbeatDueAt = undefined;
        yield HEARTBEAT;
        continue;
      }
      pending = undefined;
      if (next.done) return;
      // A dropped event leaves `heartbeatDueAt` in place, including time spent deciding.
      if (forward && !(await forward(next.value))) continue;
      heartbeatDueAt = undefined;
      yield next.value;
    }
  } finally {
    controller.abort();
    // Not awaited: closing queues behind an in-flight read until the abort lands on it, and the
    // stream (including an UNAUTHORIZED end) must not wait for that.
    void source.return(undefined).catch(() => {});
  }
}

/** Interleaves streams in arrival order; one that fails ends the rest, and stopping ends them all. */
export async function* mergeStreams<T extends unknown[]>(
  ...sources: { [K in keyof T]: AsyncGenerator<T[K]> }
): AsyncGenerator<T[number]> {
  const streams: AsyncGenerator<T[number]>[] = sources;
  const reads = new Map<number, Promise<{ index: number; result: IteratorResult<T[number]> }>>();
  const read = (index: number, stream: AsyncGenerator<T[number]>) => {
    const pending = stream.next().then((result) => ({ index, result }));
    // Raced on the next loop; this only keeps a rejection while the consumer is paused handled.
    pending.catch(() => {});
    // Re-adding moves this stream behind the others, so a busy one cannot starve the rest.
    reads.delete(index);
    reads.set(index, pending);
  };
  for (const [index, stream] of streams.entries()) read(index, stream);
  try {
    while (reads.size > 0) {
      const { index, result } = await Promise.race(reads.values());
      if (result.done) {
        reads.delete(index);
        continue;
      }
      read(index, streams[index]!);
      yield result.value;
    }
  } finally {
    for (const pending of reads.values()) pending.catch(() => {});
    for (const stream of streams) void stream.return(undefined).catch(() => {});
  }
}
