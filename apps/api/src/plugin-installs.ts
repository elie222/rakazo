import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PluginMcpServerEntry, PluginRepoFetcher } from "@rakazo/adapters";
import {
  BUILTIN_AGENT_SKILLS,
  buildMcpCredentialBlob,
  persistPreparedSecret,
  pluginPreviewDto,
  previewPluginInstall,
} from "@rakazo/adapters";
import type { Actor, CapabilityInstall, PluginPart } from "@rakazo/contracts";
import { installedPluginParts } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

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

async function loadPlugin(
  deps: PluginInstallDeps,
  source: string,
  digest: string,
  signal?: AbortSignal,
): Promise<LoadedPlugin> {
  let plugin: LoadedPlugin;
  try {
    plugin = await previewPluginInstall({ source, fetcher: deps.fetcher, signal });
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not load a supported plugin from this repository",
    });
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

const BUILTIN_SKILL_NAMES = new Set(BUILTIN_AGENT_SKILLS.map((skill) => skill.name.toLowerCase()));

function assertNoBuiltinSkillNames(plugin: LoadedPlugin) {
  if (plugin.skills.some((skill) => BUILTIN_SKILL_NAMES.has(skill.name.toLowerCase())))
    throw new ORPCError("CONFLICT", { message: "Plugin skill conflicts with a built-in skill" });
}

async function assertSkillNamesFree(
  tx: Prisma.TransactionClient,
  actor: Actor,
  plugin: LoadedPlugin,
) {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  for (const skill of plugin.skills) {
    if (
      await tx.agentSkill.findFirst({
        where: { ...scope, name: { equals: skill.name, mode: "insensitive" } },
      })
    ) {
      throw new ORPCError("CONFLICT", { message: "A plugin skill name is already in use" });
    }
  }
}

async function addSkills(
  tx: Prisma.TransactionClient,
  actor: Actor,
  installId: string,
  plugin: LoadedPlugin,
) {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  for (const skill of plugin.skills) {
    await tx.agentSkill.create({ data: { ...scope, ...skill, source: "plugin", installId } });
  }
}

async function addServers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  installId: string,
  plugin: LoadedPlugin,
  prepared: PreparedServer[],
) {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  for (const { server, stored, index } of prepared) {
    if (stored)
      await tx.secret.create({
        data: { ...scope, id: stored.id, kind: "mcp", ciphertext: stored.ciphertext },
      });
    // Stable, bounded and collision-resistant; no slug allocation loops.
    const suffix = createHash("sha256").update(`${installId}:${index}`).digest("hex").slice(0, 12);
    await tx.mcpServer.create({
      data: {
        ...scope,
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
  }
}

export function lockPluginInstalls(tx: Prisma.TransactionClient, actor: Actor) {
  // Serialize installs for this actor, including same-source duplicates. A
  // transaction-scoped advisory lock avoids an extra global uniqueness policy
  // on capability_installs (other kinds deliberately allow multiple sources).
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plugin:${actor.spaceId}:${actor.userId}`}, 0))`;
}

function installDto(row: {
  id: string;
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
    config: row.config as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

function uniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
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
  if (parts.includes("skills")) assertNoBuiltinSkillNames(plugin);
  const servers = parts.includes("connector") ? plugin.mcpServers : [];
  return withPreparedServers(deps, actor, servers, signal, async (prepared) => {
    const source = plugin.source.gitUrl + (plugin.source.subdir ? `#${plugin.source.subdir}` : "");
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    try {
      const row = await deps.prisma.$transaction(async (tx) => {
        await lockPluginInstalls(tx, actor);
        if (await tx.capabilityInstall.findFirst({ where: { ...scope, kind: "plugin", source } })) {
          throw new ORPCError("CONFLICT", { message: "This plugin is already installed" });
        }
        if (parts.includes("skills")) await assertSkillNamesFree(tx, actor, plugin);
        const install = await tx.capabilityInstall.create({
          data: {
            ...scope,
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
        if (parts.includes("skills")) await addSkills(tx, actor, install.id, plugin);
        await addServers(tx, actor, install.id, plugin, prepared);
        return install;
      });
      return installDto(row);
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new ORPCError("CONFLICT", { message: "Plugin or skill is already installed" });
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
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const existing = await deps.prisma.capabilityInstall.findFirst({
    where: { ...scope, id: input.id, kind: "plugin" },
  });
  if (!existing?.version || !existing.digest)
    throw new ORPCError("NOT_FOUND", { message: "Plugin is not installed" });
  if (!input.parts.length) return null;
  const current = installedPluginParts(existing.config as Record<string, unknown>);
  const adding = input.parts.filter((part) => !current.includes(part));
  const removing = current.filter((part) => !input.parts.includes(part));
  const plugin = adding.length
    ? await loadPlugin(deps, pinnedSource(existing), existing.digest, signal)
    : null;
  const added = plugin ? availableParts(plugin, adding) : [];
  if (plugin && added.includes("skills")) assertNoBuiltinSkillNames(plugin);
  const parts = [...current.filter((part) => !removing.includes(part)), ...added];
  if (!parts.length) return null;
  const servers = plugin && added.includes("connector") ? plugin.mcpServers : [];
  return withPreparedServers(deps, actor, servers, signal, async (prepared) => {
    try {
      const row = await deps.prisma.$transaction(async (tx) => {
        await lockPluginInstalls(tx, actor);
        const install = await tx.capabilityInstall.findFirst({
          where: { ...scope, id: existing.id },
        });
        if (!install) throw new ORPCError("NOT_FOUND", { message: "Plugin is not installed" });
        // The plan above was made from an unlocked read; another change since then invalidates it.
        const locked = installedPluginParts(install.config as Record<string, unknown>);
        if (locked.length !== current.length || locked.some((part) => !current.includes(part)))
          throw new ORPCError("CONFLICT", { message: "Plugin changed. Reload and try again" });
        if (removing.includes("connector")) {
          const rows = await tx.mcpServer.findMany({
            where: { ...scope, installId: install.id },
            select: { id: true, secretId: true },
          });
          for (const server of rows) await deps.removeServer(tx, server);
        }
        if (removing.includes("skills"))
          await tx.agentSkill.deleteMany({ where: { ...scope, installId: install.id } });
        if (plugin && added.includes("skills")) {
          await assertSkillNamesFree(tx, actor, plugin);
          await addSkills(tx, actor, install.id, plugin);
        }
        if (plugin) await addServers(tx, actor, install.id, plugin, prepared);
        return tx.capabilityInstall.update({
          where: { id: install.id },
          data: {
            config: {
              ...(install.config as Record<string, unknown>),
              parts,
            } as Prisma.InputJsonValue,
          },
        });
      });
      return installDto(row);
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new ORPCError("CONFLICT", { message: "A plugin skill name is already in use" });
      }
      throw error;
    }
  });
}
