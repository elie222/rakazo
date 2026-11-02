import { ORPCError } from "@orpc/server";
import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import type { ResolveHostname, StoredComputerSettings } from "@rakazo/adapters";
import {
  assertSafeWebUrl,
  COMPUTER_PROVIDER_SECRET_KIND,
  computerProviderDescriptor,
  computerProviderDescriptors,
  computerSettingsForProvider,
  loadComputerProviderSelection,
  loadAccountComputerSettings as loadSavedAccountComputerSettings,
  refreshComputerProvider,
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
  resolveHostname?: ResolveHostname;
  /** Test seam: confirm the desktop answers before saving. */
  verifyConnection?: (settings: StoredComputerSettings, signal: AbortSignal) => Promise<void>;
}

const VERIFY_TIMEOUT_MS = 20_000;

function view(
  provider: string,
  saved: StoredComputerSettings | null,
  defaultProvider: string,
  account = false,
  enabled = true,
): ComputerProviderSettings {
  if (!enabled) provider = "default";
  const values: Record<string, string> = {};
  const savedSecrets: Record<string, boolean> = {};
  if (saved && saved.provider === provider) {
    for (const field of computerProviderDescriptor(provider).fields) {
      if (field.kind === "secret") savedSecrets[field.key] = Boolean(saved.values[field.key]);
      else values[field.key] = saved.values[field.key] ?? "";
    }
  }
  return {
    provider,
    defaultProvider,
    values,
    savedSecrets,
    providers: enabled ? computerProviderDescriptors(account) : [],
  };
}

async function checkedSettings(
  deps: ComputerProviderConfigDeps,
  input: ComputerProviderUpdate,
  previous: StoredComputerSettings | null,
  account = false,
): Promise<StoredComputerSettings> {
  try {
    const descriptor = computerProviderDescriptor(input.provider);
    if (account && !descriptor.capabilities.perAccount)
      throw new Error("Provider does not support account settings");
    const values = { ...input.values };
    const saved = computerSettingsForProvider(previous, input.provider)?.values ?? {};
    const destinationChanged = descriptor.fields.some(
      (field) => field.kind === "url" && (values[field.key] ?? "") !== (saved[field.key] ?? ""),
    );
    for (const field of descriptor.fields) {
      if (
        field.kind === "secret" &&
        !values[field.key] &&
        !destinationChanged &&
        (!field.destination || values[field.destination] === saved[field.destination])
      )
        values[field.key] = saved[field.key] ?? "";
    }
    descriptor.verify(values);
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
    for (const field of descriptor.fields) {
      if (field.kind === "url" && values[field.key])
        await assertSafeWebUrl(values[field.key]!, deps.resolveHostname, signal);
    }
    const connections =
      !account && previous
        ? { ...previous.connections, [previous.provider]: previous.values }
        : undefined;
    if (connections) delete connections[input.provider];
    const settings = {
      provider: input.provider,
      values,
      ...(connections && Object.keys(connections).length ? { connections } : {}),
    };
    if (deps.verifyConnection) await deps.verifyConnection(settings, signal);
    else await descriptor.verifyConnection?.(values, signal);
    return settings;
  } catch {
    // Provider failures and schema errors can contain credentials. Never echo them.
    throw new ORPCError("BAD_REQUEST", { message: "Could not verify computer settings" });
  }
}

function encrypt(deps: ComputerProviderConfigDeps, actor: Actor, settings: StoredComputerSettings) {
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
  return view(
    selection.provider,
    selection.settings,
    deps.env.sandboxProvider,
    false,
    routesBySettings(deps.env.sandboxProvider),
  );
}

export async function updateComputerProviderSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  await requireAdmin(deps, actor.userId);
  if (input.provider !== "default" && !routesBySettings(deps.env.sandboxProvider))
    throw new ORPCError("BAD_REQUEST", { message: "This deployment cannot use computer settings" });
  const existing = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  if (input.provider === "default") {
    // Keep the connection for computers already using it.
    await runAsSystem("an admin keeps computers on the deployment provider", () =>
      deps.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", computerProvider: null },
        update: { computerProvider: null },
      }),
    );
    await refreshComputerProvider(deps.sandbox);
    return view(
      "default",
      existing.settings,
      deps.env.sandboxProvider,
      false,
      routesBySettings(deps.env.sandboxProvider),
    );
  }
  // Blank secrets keep the saved ones, so an admin never has to see them again.
  const settings = await checkedSettings(deps, input, existing.settings);
  const stored = await encrypt(deps, actor, settings);
  await withSerializableRetry(() =>
    runAsSystem("an admin configures computers", () =>
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
              kind: COMPUTER_PROVIDER_SECRET_KIND,
              ciphertext: stored.ciphertext,
            },
          });
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: {
              id: "default",
              computerProvider: input.provider,
              computerProviderSecretId: secret.id,
            },
            update: { computerProvider: input.provider, computerProviderSecretId: secret.id },
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
  return view(input.provider, settings, deps.env.sandboxProvider);
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

/** Account computer settings. */
export async function getAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  const [saved, defaultProvider] = await Promise.all([
    loadSavedAccountComputerSettings(deps.prisma, deps.secrets, actor.userId),
    deploymentProvider(deps),
  ]);
  return view(
    saved?.provider ?? "default",
    saved,
    defaultProvider,
    true,
    routesBySettings(deps.env.sandboxProvider),
  );
}

export async function updateAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  // Those deployments run every computer on their own provider, never one chosen in Settings.
  if (!routesBySettings(deps.env.sandboxProvider))
    throw new ORPCError("BAD_REQUEST", {
      message: "This deployment cannot use account computer settings",
    });
  const mine = { userId: actor.userId, spaceId: null, kind: COMPUTER_PROVIDER_SECRET_KIND };
  let saved: StoredComputerSettings | null = null;
  if (input.provider === "default") {
    // The account's computers move to the deployment's desktop the next time they start.
    await runAsSystem("an account goes back to the deployment's computers", () =>
      deps.prisma.secret.deleteMany({ where: mine }),
    );
  } else {
    const previous = await loadSavedAccountComputerSettings(
      deps.prisma,
      deps.secrets,
      actor.userId,
    );
    saved = await checkedSettings(deps, input, previous, true);
    const stored = await encrypt(deps, actor, saved);
    await withSerializableRetry(() =>
      runAsSystem("an account saves computer settings", () =>
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
  return view(saved?.provider ?? "default", saved, await deploymentProvider(deps), true);
}

/** Whether computers on this deployment can run where Settings says. */
function routesBySettings(envProvider: string) {
  return envProvider !== "desktop" && envProvider !== "fake";
}

/** Effective provider id after the account and deployment overrides. */
export function effectiveSandboxProvider(
  settings: { computerProvider?: string | null; computerProviderSecretId?: string | null } | null,
  envProvider: string,
  ownProvider?: string,
) {
  if (!routesBySettings(envProvider)) return envProvider;
  return (
    ownProvider || (settings?.computerProviderSecretId && settings.computerProvider) || envProvider
  );
}
