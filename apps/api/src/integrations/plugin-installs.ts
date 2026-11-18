import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PluginMcpServerEntry, PluginRepoFetcher } from "@rakazo/adapters";
import {
  buildMcpCredentialBlob,
  isPluginLoadFault,
  persistPreparedSecret,
  pluginPreviewDto,
  previewPluginInstall,
} from "@rakazo/adapters";
import type { Actor, CapabilityInstall, PluginPart } from "@rakazo/contracts";
import { ClientError, installedPluginParts } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  availableInSpace,
  isUniqueViolation,
  JsonObject,
  readJsonColumn,
  runAsSystemInTransaction,
  spaceAvailability,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { assertNameFreeWhereAvailable, lockOwner, NameTakenError } from "../spaces/name-claims.js";

export type PluginInstallDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  fetcher?: PluginRepoFetcher;
  assertEndpoint: (endpoint: string) => Promise<void>;
};

type LoadedPlugin = Awaited<ReturnType<typeof previewPluginInstall>>;
type PreparedServer = {
  server: PluginMcpServerEntry;
  stored: Awaited<ReturnType<SecretStore["put"]>> | null;
  index: number;
};

/**
 * The caller named the address, so failing to reach or read it is their answer, not a server
 * error; this returns for the caller to give it. A cancelled request and a fault in our own
 * code are rethrown.
 */
export function rethrowUnlessPluginSourceFailed(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || isPluginLoadFault(error)) throw error;
  getLogger().warn("plugin source not loaded", { error });
}

async function loadPlugin(
  deps: PluginInstallDeps,
  source: string,
  digest: string,
  signal?: AbortSignal,
): Promise<LoadedPlugin> {
  let plugin: LoadedPlugin;
  try {
    plugin = await previewPluginInstall({ source, fetcher: deps.fetcher, signal });
  } catch (error) {
    rethrowUnlessPluginSourceFailed(error, signal);
    throw new ClientError("BAD_REQUEST", "Could not load a supported plugin from this repository");
  }
  if (plugin.digest !== digest) {
    throw new ORPCError("CONFLICT", {
      message: "Plugin content changed; preview and confirm again",
    });
  }
  return plugin;
}

/** Parts the plugin actually has, out of the ones asked for. */
function availableParts(plugin: LoadedPlugin, wanted: readonly PluginPart[]): PluginPart[] {
  return wanted.filter((part) =>
    part === "connector" ? plugin.mcpServers.length > 0 : plugin.skills.length > 0,
  );
}

/** Network validation and encryption run before the transaction; written secrets are
 * cleaned up if the transaction never references them. */
function withPreparedServers<T>(
  deps: PluginInstallDeps,
  actor: Actor,
  servers: PluginMcpServerEntry[],
  signal: AbortSignal | undefined,
  commit: (prepared: PreparedServer[]) => Promise<T>,
): Promise<T> {
  const prepared: PreparedServer[] = [];
  async function prepare(index: number): Promise<T> {
    const server = servers[index];
    if (!server) return commit(prepared);
    await deps.assertEndpoint(server.endpoint);
    const material = buildMcpCredentialBlob({ headers: server.headers });
    const stored = material
      ? await deps.secrets.put(material, {
          operationId: "capabilities.install",
          traceId: "capabilities.install",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: signal ?? new AbortController().signal,
        })
      : null;
    prepared.push({ server, stored, index });
    return persistPreparedSecret(deps.prisma, deps.secrets, stored ?? undefined, () =>
      prepare(index + 1),
    );
  }
  return prepare(0);
}

/** Where an install's skills and connectors live: wherever the install itself is available. */
type InstallPlacement = {
  id: string;
  spaceId: string;
  userId: string;
  allSpaces: boolean;
  availableIn: Array<{ spaceId: string }>;
};

async function assertSkillNamesFree(
  tx: Prisma.TransactionClient,
  actor: Actor,
  plugin: LoadedPlugin,
  install: Pick<InstallPlacement, "spaceId" | "allSpaces" | "availableIn">,
) {
  for (const skill of plugin.skills) {
    try {
      await assertNameFreeWhereAvailable(
        tx,
        "skill",
        actor,
        skill.name,
        spaceAvailability(install),
      );
    } catch (error) {
      if (!(error instanceof NameTakenError)) throw error;
      throw new ClientError("CONFLICT", "A plugin skill name is already in use");
    }
  }
}

function extraSpaces(install: InstallPlacement) {
  return install.availableIn
    .map((entry) => entry.spaceId)
    .filter((spaceId) => spaceId !== install.spaceId);
}

// Parts may be added from another space the install is available in, so they are written in
// the install's own space; the caller checked the install is the actor's.
async function addSkills(
  tx: Prisma.TransactionClient,
  install: InstallPlacement,
  plugin: LoadedPlugin,
) {
  await runAsSystemInTransaction(tx, "add a plugin's skills where it is installed", async () => {
    for (const skill of plugin.skills) {
      const row = await tx.agentSkill.create({
        data: {
          spaceId: install.spaceId,
          userId: install.userId,
          allSpaces: install.allSpaces,
          ...skill,
          source: "plugin",
          installId: install.id,
        },
      });
      await tx.agentSkillSpace.createMany({
        data: extraSpaces(install).map((spaceId) => ({
          skillId: row.id,
          spaceId,
          userId: install.userId,
        })),
      });
    }
  });
}

async function addServers(
  tx: Prisma.TransactionClient,
  install: InstallPlacement,
  plugin: LoadedPlugin,
  prepared: PreparedServer[],
) {
  // Secrets of a connector available beyond one space are the account's, so each space reads them.
  const shared = install.allSpaces || extraSpaces(install).length > 0;
  await runAsSystemInTransaction(tx, "add a plugin's connectors where it is installed", () =>
    addServerRows(tx, install, plugin, prepared, shared),
  );
}

async function addServerRows(
  tx: Prisma.TransactionClient,
  install: InstallPlacement,
  plugin: LoadedPlugin,
  prepared: PreparedServer[],
  shared: boolean,
) {
  const installId = install.id;
  for (const { server, stored, index } of prepared) {
    if (stored)
      await tx.secret.create({
        data: {
          userId: install.userId,
          spaceId: shared ? null : install.spaceId,
          id: stored.id,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    // Stable, bounded and collision-resistant; no slug allocation loops.
    const suffix = createHash("sha256").update(`${installId}:${index}`).digest("hex").slice(0, 12);
    const row = await tx.mcpServer.create({
      data: {
        spaceId: install.spaceId,
        userId: install.userId,
        allSpaces: install.allSpaces,
        installId,
        slug: `${plugin.name.slice(0, 48)}-${suffix}`,
        name: `${plugin.name}: ${server.name}`.slice(0, 120),
        description: `Installed from plugin ${plugin.name}`,
        transport: server.transport,
        endpoint: server.endpoint,
        args: [],
        env: {},
        headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, true])),
        secretId: stored?.id,
        enabled: true,
      },
    });
    await tx.mcpServerSpace.createMany({
      data: extraSpaces(install).map((spaceId) => ({
        serverId: row.id,
        spaceId,
        userId: install.userId,
      })),
    });
  }
}

export function lockPluginInstalls(tx: Prisma.TransactionClient, actor: Actor) {
  // Serialize installs for this actor, including same-source duplicates. A
  // transaction-scoped advisory lock avoids an extra global uniqueness policy
  // on capability_installs (other kinds deliberately allow multiple sources).
  return lockOwner(tx, actor.userId, "plugin");
}

/**
 * An install's stored settings. To show them, a row that holds no object reads as none (with a
 * warning). A change is planned from them and written back over them, so `"reject"` fails it.
 */
export function installConfig(
  install: { id: string; config: unknown },
  onMismatch: "reject" | { fallback: Record<string, never> } = { fallback: {} },
): Record<string, unknown> {
  return readJsonColumn(
    JsonObject,
    install.config,
    { table: "capability_installs", column: "config", id: install.id },
    onMismatch,
  );
}

function installDto(row: {
  id: string;
  spaceId: string;
  allSpaces: boolean;
  availableIn?: Array<{ spaceId: string }>;
  name: string;
  source: string;
  version: string | null;
  digest: string | null;
  config: unknown;
  createdAt: Date;
}): CapabilityInstall {
  return {
    id: row.id,
    kind: "plugin",
    name: row.name,
    source: row.source,
    version: row.version,
    digest: row.digest,
    secretConfigured: false,
    config: installConfig(row),
    availability: spaceAvailability(row),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function installPlugin(
  deps: PluginInstallDeps,
  actor: Actor,
  input: {
    source: string;
    name: string;
    config: Record<string, unknown>;
    credential?: string;
    pluginDigest?: string;
    pluginParts?: PluginPart[];
  },
  signal?: AbortSignal,
): Promise<CapabilityInstall> {
  if (input.credential || Object.keys(input.config).length) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Plugin credentials must be configured per MCP server after installation",
    });
  }
  if (!input.pluginDigest) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Preview and confirm the plugin before installing",
    });
  }
  const plugin = await loadPlugin(deps, input.source, input.pluginDigest, signal);
  const parts = availableParts(plugin, input.pluginParts ?? ["connector", "skills"]);
  if (!parts.length) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Plugin has no supported skills or MCP servers",
    });
  }
  const servers = parts.includes("connector") ? plugin.mcpServers : [];
  return withPreparedServers(deps, actor, servers, signal, async (prepared) => {
    const source = plugin.source.gitUrl + (plugin.source.subdir ? `#${plugin.source.subdir}` : "");
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    try {
      const row = await deps.prisma.$transaction(
        async (tx) => {
          await lockPluginInstalls(tx, actor);
          // One install per plugin and account, since it is available in all the user's spaces.
          const installed = await runAsSystemInTransaction(
            tx,
            "owner's plugin installs across their spaces",
            () =>
              tx.capabilityInstall.findFirst({
                where: { userId: actor.userId, kind: "plugin", source },
              }),
          );
          if (installed) {
            throw new ORPCError("CONFLICT", { message: "This plugin is already installed" });
          }
          const everywhere = { spaceId: actor.spaceId, allSpaces: true, availableIn: [] };
          if (parts.includes("skills")) await assertSkillNamesFree(tx, actor, plugin, everywhere);
          const install = await tx.capabilityInstall.create({
            data: {
              ...scope,
              allSpaces: true,
              kind: "plugin",
              name: input.name.trim() || plugin.name,
              source,
              version: plugin.resolvedSha,
              digest: plugin.digest,
              config: {
                ...pluginPreviewDto(plugin),
                requestedRef: plugin.source.ref ?? null,
                subdir: plugin.source.subdir ?? null,
                parts,
              } as Prisma.InputJsonValue,
            },
          });
          const placed = { ...install, availableIn: [] };
          if (parts.includes("skills")) await addSkills(tx, placed, plugin);
          await addServers(tx, placed, plugin, prepared);
          return placed;
        },
        { timeout: 60_000 },
      );
      return installDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ClientError("CONFLICT", "Plugin or skill is already installed");
      }
      throw error;
    }
  });
}

/** The pinned commit an install was made from, so a later part comes from the same content. */
function pinnedSource(install: { source: string; version: string | null }): string {
  const [repo, subdir] = install.source.split("#");
  return `${repo}@${install.version}${subdir ? `#${subdir}` : ""}`;
}

/**
 * Adds or removes a plugin's connector or skills. Added parts are read again at the
 * install's pinned commit and must match its digest. Returns null when no part is left,
 * in which case the caller removes the install.
 */
export async function setPluginParts(
  deps: PluginInstallDeps & {
    removeServer: (
      tx: Prisma.TransactionClient,
      server: { id: string; secretId: string | null },
    ) => Promise<unknown>;
  },
  actor: Actor,
  input: { id: string; parts: PluginPart[] },
  signal?: AbortSignal,
): Promise<CapabilityInstall | null> {
  const existing = await deps.prisma.capabilityInstall.findFirst({
    where: { ...availableInSpace(actor), id: input.id, kind: "plugin" },
  });
  if (!existing?.version || !existing.digest)
    throw new ORPCError("NOT_FOUND", { message: "Plugin is not installed" });
  if (!input.parts.length) return null;
  const current = installedPluginParts(installConfig(existing, "reject"));
  const adding = input.parts.filter((part) => !current.includes(part));
  const removing = current.filter((part) => !input.parts.includes(part));
  const plugin = adding.length
    ? await loadPlugin(deps, pinnedSource(existing), existing.digest, signal)
    : null;
  const added = plugin ? availableParts(plugin, adding) : [];
  const parts = [...current.filter((part) => !removing.includes(part)), ...added];
  if (!parts.length) return null;
  const servers = plugin && added.includes("connector") ? plugin.mcpServers : [];
  return withPreparedServers(deps, actor, servers, signal, async (prepared) => {
    try {
      const row = await deps.prisma.$transaction(
        async (tx) => {
          await lockPluginInstalls(tx, actor);
          const install = await tx.capabilityInstall.findFirst({
            where: { ...availableInSpace(actor), id: existing.id },
            include: { availableIn: AVAILABILITY_SELECT },
          });
          if (!install) throw new ORPCError("NOT_FOUND", { message: "Plugin is not installed" });
          const owned = { userId: actor.userId, installId: install.id };
          // The plan above was made from an unlocked read; another change since then invalidates it.
          const config = installConfig(install, "reject");
          const locked = installedPluginParts(config);
          if (locked.length !== current.length || locked.some((part) => !current.includes(part)))
            throw new ORPCError("CONFLICT", { message: "Plugin changed. Reload and try again" });
          if (removing.includes("connector")) {
            const rows = await tx.mcpServer.findMany({
              where: owned,
              select: { id: true, secretId: true },
            });
            for (const server of rows) await deps.removeServer(tx, server);
          }
          if (removing.includes("skills")) await tx.agentSkill.deleteMany({ where: owned });
          if (plugin && added.includes("skills")) {
            await assertSkillNamesFree(tx, actor, plugin, install);
            await addSkills(tx, install, plugin);
          }
          if (plugin) await addServers(tx, install, plugin, prepared);
          const updated = await tx.capabilityInstall.update({
            where: { id: install.id },
            data: {
              config: {
                ...config,
                // Re-read at the pinned commit, so the saved preview matches what is installed now.
                ...(plugin ? pluginPreviewDto(plugin) : {}),
                parts,
              } as Prisma.InputJsonValue,
            },
          });
          return { ...updated, availableIn: install.availableIn };
        },
        { timeout: 60_000 },
      );
      return installDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ClientError("CONFLICT", "A plugin skill name is already in use");
      }
      throw error;
    }
  });
}
