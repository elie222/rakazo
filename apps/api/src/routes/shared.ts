import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  deploymentModelRole,
  hasHostedModelCredits,
  hostCredentialSource,
  mcpStdioAvailable,
  resolveMemberMainModel,
} from "@rakazo/adapters";
import type { Actor, Me } from "@rakazo/contracts";
import { attachmentMaxBytes, canonicalPiProviderId } from "@rakazo/contracts";
import type { RouterDeps } from "../router.js";

export function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      include: { signupSurvey: { select: { userId: true } } },
    }),
    modelSetup(deps, actor),
  ]);
  return {
    ticketBoardEnabled: deps.env.ticketBoardEnabled === true,
    phoneCallsEnabled: deps.env.phoneCallsEnabled === true,
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: false,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(setup.model?.provider ?? deps.env.defaultProvider),
    defaultModel: setup.model?.modelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.main &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    computerHost: computerHostFor(setup.settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer:
      Boolean(deps.env.desktopHostChoiceEnabled) && deps.env.sandboxProvider === "docker",
    sandboxProvider: deps.env.sandboxProvider,
    mcpStdioEnabled: mcpStdioAvailable({
      stdioEnabled: deps.env.mcpStdioEnabled,
      allowedCommands: deps.env.mcpStdioAllowedCommands,
    }),
    avatarStyle: "organic",
    timezone: user.timezone ?? null,
    billingEnabled: Boolean(deps.billing),
    // Only billing deployments ask; self-hosted installs never see the survey.
    needsSignupSurvey: Boolean(deps.billing) && !user.signupSurvey,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
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
  const funding = deps.billing ? await deps.billing.status(actor) : null;
  const hasDeployment =
    Boolean(deps.env.deploymentModelConfigured) &&
    (!funding?.creditPurchasesEnabled || funding.funding === "credits");
  return {
    main,
    model:
      main ??
      deploymentModelRole("main", {
        settings,
        deployment: { provider: deps.env.defaultProvider, model: deps.env.defaultModel },
      }).primary,
    settings,
    needsModel: deps.env.agentRuntime !== "scripted" && !main && !hasDeployment,
  };
}

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export function isRecordNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2025");
}
