import { ORPCError } from "@orpc/server";
import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import type { StoredWuyingSettings } from "@rakazo/adapters";
import {
  ACCOUNT_WUYING_SECRET_KIND,
  loadAccountWuyingSettings,
  loadComputerProviderSelection,
  refreshComputerProvider,
  verifyWuyingConnection,
} from "@rakazo/adapters";
import type { Actor, ComputerProviderSettings, ComputerProviderUpdate } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";
import { withSerializableRetry } from "./serializable-retry.js";

export interface ComputerProviderConfigDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
  sandbox: SandboxProvider;
  env: Pick<RouterDeps["env"], "sandboxProvider" | "adminEmails">;
  /** Test seam: confirm the desktop answers before saving. */
  verifyWuying?: (settings: StoredWuyingSettings, signal: AbortSignal) => Promise<void>;
}

const VERIFY_TIMEOUT_MS = 20_000;

function view(
  wuying: boolean,
  saved: StoredWuyingSettings | null,
  defaultProvider: string,
): ComputerProviderSettings {
  return {
    provider: wuying ? "wuying" : "default",
    defaultProvider,
    wuying: saved
      ? {
          regionId: saved.regionId,
          desktopId: saved.desktopId,
          endUserId: saved.endUserId,
          mcpUrl: saved.mcpUrl,
          hasAccessKey: Boolean(saved.accessKeyId && saved.accessKeySecret),
          hasMcpToken: Boolean(saved.mcpToken),
        }
      : null,
  };
}

/** The connection to save, checked against the desktop. Blank secrets keep the saved ones. */
async function checkedWuyingSettings(
  deps: ComputerProviderConfigDeps,
  given: ComputerProviderUpdate["wuying"],
  previous: StoredWuyingSettings | null,
): Promise<StoredWuyingSettings> {
  if (!given) throw new ORPCError("BAD_REQUEST", { message: "Wuying settings are missing" });
  // The saved token goes only to the gateway it was saved for.
  const settings: StoredWuyingSettings = {
    regionId: given.regionId || "cn-hangzhou",
    desktopId: given.desktopId,
    endUserId: given.endUserId,
    mcpUrl: given.mcpUrl,
    accessKeyId: given.accessKeyId || previous?.accessKeyId || "",
    accessKeySecret: given.accessKeySecret || previous?.accessKeySecret || "",
    mcpToken: given.mcpToken || (previous?.mcpUrl === given.mcpUrl ? previous.mcpToken : "") || "",
  };
  const missing = Object.entries(settings).find(([, value]) => !value);
  if (missing) throw new ORPCError("BAD_REQUEST", { message: `Wuying ${missing[0]} is required` });
  try {
    await (deps.verifyWuying ?? verifyWuyingConnection)(
      settings,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    );
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Could not reach the Wuying desktop: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return settings;
}

function encrypt(deps: ComputerProviderConfigDeps, actor: Actor, settings: StoredWuyingSettings) {
  return deps.secrets.put(JSON.stringify(settings), {
    operationId: "computer-provider-config",
    traceId: "computer-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
}

export async function getComputerProviderSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  await requireAdmin(deps, actor.userId);
  const selection = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  return view(selection.wuying, selection.settings, deps.env.sandboxProvider);
}

export async function updateComputerProviderSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  await requireAdmin(deps, actor.userId);
  const existing = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  if (input.provider === "default") {
    // The saved connection stays, so computers already on Wuying keep working.
    await runAsSystem("an admin keeps computers on the deployment provider", () =>
      deps.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", computerProvider: null },
        update: { computerProvider: null },
      }),
    );
    await refreshComputerProvider(deps.sandbox);
    return view(false, existing.settings, deps.env.sandboxProvider);
  }
  // Blank secrets keep the saved ones, so an admin never has to see them again.
  const settings = await checkedWuyingSettings(deps, input.wuying, existing.settings);
  const stored = await encrypt(deps, actor, settings);
  await withSerializableRetry(() =>
    runAsSystem("an admin sends new computers to Wuying", () =>
      deps.prisma.$transaction(
        async (tx) => {
          const current = await tx.deploymentSettings.findUnique({
            where: { id: "default" },
            select: { computerProviderSecretId: true },
          });
          const secret = await tx.secret.create({
            data: {
              id: stored.id,
              userId: actor.userId,
              spaceId: actor.spaceId,
              kind: "computer-provider",
              ciphertext: stored.ciphertext,
            },
          });
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: {
              id: "default",
              computerProvider: "wuying",
              computerProviderSecretId: secret.id,
            },
            update: { computerProvider: "wuying", computerProviderSecretId: secret.id },
          });
          if (current?.computerProviderSecretId && current.computerProviderSecretId !== secret.id) {
            await tx.secret.deleteMany({ where: { id: current.computerProviderSecretId } });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
  await refreshComputerProvider(deps.sandbox);
  return view(true, settings, deps.env.sandboxProvider);
}

/** Where computers run while an account keeps the deployment default. */
async function deploymentProvider(deps: ComputerProviderConfigDeps) {
  const settings = await runAsSystem("read the deployment's computer provider", () =>
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { computerProvider: true, computerProviderSecretId: true },
    }),
  );
  return effectiveSandboxProvider(settings, deps.env.sandboxProvider);
}

/** The Wuying desktop the signed-in account runs its own Team Computers on, if it saved one. */
export async function getAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  const [saved, defaultProvider] = await Promise.all([
    loadAccountWuyingSettings(deps.prisma, deps.secrets, actor.userId),
    deploymentProvider(deps),
  ]);
  return view(saved !== null, saved, defaultProvider);
}

export async function updateAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  // Those deployments run every computer on their own provider, never one chosen in Settings.
  if (!routesBySettings(deps.env.sandboxProvider))
    throw new ORPCError("BAD_REQUEST", { message: "This deployment cannot use Wuying computers" });
  const mine = { userId: actor.userId, spaceId: null, kind: ACCOUNT_WUYING_SECRET_KIND };
  let saved: StoredWuyingSettings | null = null;
  if (input.provider === "default") {
    // The account's computers move to the deployment's desktop the next time they start.
    await runAsSystem("an account goes back to the deployment's computers", () =>
      deps.prisma.secret.deleteMany({ where: mine }),
    );
  } else {
    const previous = await loadAccountWuyingSettings(deps.prisma, deps.secrets, actor.userId);
    saved = await checkedWuyingSettings(deps, input.wuying, previous);
    const stored = await encrypt(deps, actor, saved);
    await withSerializableRetry(() =>
      runAsSystem("an account saves its own Wuying desktop", () =>
        deps.prisma.$transaction(
          async (tx) => {
            // Account-level, so it outlives any one space and only its owner can read it.
            const secret = await tx.secret.create({
              data: { ...mine, id: stored.id, ciphertext: stored.ciphertext },
            });
            await tx.secret.deleteMany({ where: { ...mine, id: { not: secret.id } } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  }
  await refreshComputerProvider(deps.sandbox);
  return view(saved !== null, saved, await deploymentProvider(deps));
}

/** Whether computers on this deployment can run where Settings says. */
function routesBySettings(envProvider: string) {
  return envProvider !== "desktop" && envProvider !== "fake";
}

/**
 * The provider Me reports: the account's own Wuying desktop, else Settings' choice when it holds
 * a saved Wuying connection.
 */
export function effectiveSandboxProvider(
  settings: { computerProvider?: string | null; computerProviderSecretId?: string | null } | null,
  envProvider: string,
  ownWuying = false,
) {
  if (ownWuying && routesBySettings(envProvider)) return "wuying";
  return settings?.computerProvider === "wuying" && settings.computerProviderSecretId
    ? "wuying"
    : envProvider;
}
