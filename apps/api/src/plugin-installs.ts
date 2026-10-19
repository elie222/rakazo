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
import type { Actor, CapabilityInstall } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

export type PluginInstallDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  fetcher?: PluginRepoFetcher;
  assertEndpoint: (endpoint: string) => Promise<void>;
};

export async function installPlugin(
  deps: PluginInstallDeps,
  actor: Actor,
  input: {
    source: string;
    name: string;
    config: Record<string, unknown>;
    credential?: string;
    pluginDigest?: string;
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
  let plugin: Awaited<ReturnType<typeof previewPluginInstall>>;
  try {
    plugin = await previewPluginInstall({ source: input.source, fetcher: deps.fetcher, signal });
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not load a supported plugin from this repository",
    });
  }
  if (plugin.digest !== input.pluginDigest) {
    throw new ORPCError("CONFLICT", {
      message: "Plugin content changed; preview and confirm again",
    });
  }
  if (!plugin.skills.length && !plugin.mcpServers.length) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Plugin has no supported skills or MCP servers",
    });
  }
  const builtinNames = new Set(BUILTIN_AGENT_SKILLS.map((skill) => skill.name.toLowerCase()));
  for (const skill of plugin.skills) {
    if (builtinNames.has(skill.name.toLowerCase()))
      throw new ORPCError("CONFLICT", { message: "Plugin skill conflicts with a built-in skill" });
  }
  // Prepare network validation and encryption outside the DB transaction.
  const preparedServers: Array<{
    server: PluginMcpServerEntry;
    stored: Awaited<ReturnType<SecretStore["put"]>> | null;
    index: number;
  }> = [];
  async function prepare(index: number): Promise<CapabilityInstall> {
    const server = plugin.mcpServers[index];
    if (!server) return commit();
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
    preparedServers.push({ server, stored, index });
    return persistPreparedSecret(deps.prisma, deps.secrets, stored ?? undefined, () =>
      prepare(index + 1),
    );
  }
  async function commit(): Promise<CapabilityInstall> {
    const source = plugin.source.gitUrl + (plugin.source.subdir ? `#${plugin.source.subdir}` : "");
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    try {
      const row = await deps.prisma.$transaction(async (tx) => {
        // Serialize installs for this actor, including same-source duplicates. A
        // transaction-scoped advisory lock avoids an extra global uniqueness policy
        // on capability_installs (other kinds deliberately allow multiple sources).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plugin:${actor.spaceId}:${actor.userId}`}, 0))`;
        if (await tx.capabilityInstall.findFirst({ where: { ...scope, kind: "plugin", source } })) {
          throw new ORPCError("CONFLICT", { message: "This plugin is already installed" });
        }
        for (const skill of plugin.skills) {
          if (
            await tx.agentSkill.findFirst({
              where: { ...scope, name: { equals: skill.name, mode: "insensitive" } },
            })
          ) {
            throw new ORPCError("CONFLICT", { message: "A plugin skill name is already in use" });
          }
        }
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
            } as Prisma.InputJsonValue,
          },
        });
        for (const skill of plugin.skills) {
          await tx.agentSkill.create({
            data: { ...scope, ...skill, source: "plugin", installId: install.id },
          });
        }
        for (const { server, stored, index } of preparedServers) {
          if (stored)
            await tx.secret.create({
              data: { ...scope, id: stored.id, kind: "mcp", ciphertext: stored.ciphertext },
            });
          // Stable, bounded and collision-resistant; no slug allocation loops.
          const suffix = createHash("sha256")
            .update(`${install.id}:${index}`)
            .digest("hex")
            .slice(0, 12);
          await tx.mcpServer.create({
            data: {
              ...scope,
              installId: install.id,
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
        return install;
      });
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
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new ORPCError("CONFLICT", { message: "Plugin or skill is already installed" });
      }
      throw error;
    }
  }
  return prepare(0);
}
