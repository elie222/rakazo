import type {
  Actor,
  Connector,
  CreateConnectorInput,
  CreateGlobalBotInput,
  GlobalBot,
  SetSpacePermissionsInput,
  SpaceGlobalBot,
  SpacePermissionsView,
  SpacePermission,
  ThinkingLevel,
  UpdateConnectorInput,
  UpdateGlobalBotInput,
} from "@rakazo/contracts";
import {
  DEFAULT_ROLE_PERMISSIONS,
  initialBotMemory,
  SpacePermission as SpacePermissionSchema,
} from "@rakazo/contracts";
import { displayName } from "@rakazo/core";
import { threadsForUser } from "./bot-threads.js";
import type { Prisma, PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";
import { permissionsForRole } from "./permissions.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2025");
}

type GlobalBotRow = {
  id: string;
  slug: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  color: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  disabledBuiltinTools: string[];
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  connectors?: Array<{ connectorId: string; position: number }>;
};

const globalBotInclude = {
  connectors: { select: { connectorId: true, position: true } },
} as const;

function mapGlobalBot(row: GlobalBotRow): GlobalBot {
  const connectorIds = [...(row.connectors ?? [])]
    .sort((a, b) => a.position - b.position || a.connectorId.localeCompare(b.connectorId))
    .map((link) => link.connectorId);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    title: displayName(row.title, ""),
    description: row.description,
    instructions: row.instructions,
    color: row.color,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    thinkingLevel: (row.thinkingLevel as ThinkingLevel | null) ?? null,
    disabledBuiltinTools: row.disabledBuiltinTools,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    connectorIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type ConnectorRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  skillRefs: unknown;
  mcpConfig: unknown;
  version: string;
  createdAt: Date;
  updatedAt: Date;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function mapConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    skillRefs: asStringArray(row.skillRefs),
    mcpConfig: row.mcpConfig ?? {},
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Deployment catalog admin: DeploymentSettings.ownerUserId.
 * When unset, the first caller claims ownership so a self-hosted install can
 * publish Global bots without a manual SQL update.
 */
export async function requireDeploymentCatalogAdmin(
  prisma: PrismaClient,
  actor: Actor,
): Promise<void> {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (settings?.ownerUserId === actor.userId) return;
  if (settings?.ownerUserId) throw new IsolationError("Deployment admin required");
  const claimed = await prisma.deploymentSettings.updateMany({
    where: { id: "default", ownerUserId: null },
    data: { ownerUserId: actor.userId },
  });
  if (claimed.count === 1) return;
  const again = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (again?.ownerUserId === actor.userId) return;
  throw new IsolationError("Deployment admin required");
}

export async function requireSpaceOwnerRole(actor: Actor): Promise<void> {
  const roles = actor.role
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  if (!roles.includes("owner")) throw new IsolationError("Space owner required");
}

/** Create or return the caller's thread on a bot (Global instances are multi-user). */
export async function ensureUserThreadForBot(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  bot: { id: string; spaceId: string },
) {
  const existing = await prisma.thread.findUnique({
    where: { botId_userId: { botId: bot.id, userId: actor.userId } },
  });
  if (existing) return existing;
  try {
    return await prisma.thread.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: actor.userId,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.thread.findUniqueOrThrow({
      where: { botId_userId: { botId: bot.id, userId: actor.userId } },
    });
  }
}

export function createGlobalBotRepos(prisma: PrismaClient) {
  async function loadGlobalBot(globalBotId: string): Promise<GlobalBot> {
    const row = await prisma.globalBot.findUnique({
      where: { id: globalBotId },
      include: globalBotInclude,
    });
    if (!row) throw new IsolationError();
    return mapGlobalBot(row);
  }

  async function materializeSpaceBot(
    tx: Prisma.TransactionClient,
    actor: Actor,
    global: {
      id: string;
      name: string;
      title: string;
      description: string;
      instructions: string;
      color: string;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
      disabledBuiltinTools: string[];
    },
  ): Promise<{ id: string }> {
    const existing = await tx.bot.findUnique({
      where: {
        spaceId_globalBotId: { spaceId: actor.spaceId, globalBotId: global.id },
      },
    });
    if (existing) {
      if (existing.archivedAt) {
        await tx.bot.update({
          where: { id: existing.id },
          data: {
            archivedAt: null,
            name: displayName(global.name, ""),
            title: displayName(global.title, ""),
            description: global.description,
            instructions: global.instructions,
            color: global.color,
            modelProvider: global.modelProvider,
            modelId: global.modelId,
            thinkingLevel: global.thinkingLevel,
            disabledBuiltinTools: global.disabledBuiltinTools,
          },
        });
      }
      return { id: existing.id };
    }

    await lockSpaceForContentCreation(tx, {
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
    const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
    const kind =
      envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
    const positions = await tx.bot.aggregate({
      where: { spaceId: actor.spaceId, userId: null, globalBotId: { not: null } },
      _max: { position: true },
    });
    const created = await tx.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: null,
        globalBotId: global.id,
        name: displayName(global.name, ""),
        title: displayName(global.title, ""),
        description: global.description,
        instructions: global.instructions,
        color: global.color,
        position: (positions._max.position ?? -1) + 1,
        modelProvider: global.modelProvider,
        modelId: global.modelId,
        thinkingLevel: global.thinkingLevel,
        disabledBuiltinTools: global.disabledBuiltinTools,
        notifyOnFinish: true,
        fleetManagement: false,
      },
    });
    const dedicated = await ensureComputerRecord(tx, {
      mode: "dedicated",
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: created.id,
      kind,
    });
    await tx.bot.update({
      where: { id: created.id },
      data: { computerId: dedicated.id },
    });
    await tx.browserProfile.create({
      data: {
        spaceId: actor.spaceId,
        botId: created.id,
        userId: actor.userId,
      },
    });
    await tx.memoryDocument.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: created.id,
        scope: "bot",
        path: "MEMORY.md",
        content: initialBotMemory(global.name),
      },
    });
    return { id: created.id };
  }

  return {
    async listPublishedGlobalBots(): Promise<GlobalBot[]> {
      const rows = await prisma.globalBot.findMany({
        where: { publishedAt: { not: null } },
        include: globalBotInclude,
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapGlobalBot);
    },

    async getGlobalBot(globalBotId: string, options: { publishedOnly?: boolean } = {}) {
      const row = await prisma.globalBot.findUnique({
        where: { id: globalBotId },
        include: globalBotInclude,
      });
      if (!row) throw new IsolationError();
      if (options.publishedOnly && !row.publishedAt) throw new IsolationError();
      return mapGlobalBot(row);
    },

    async createGlobalBot(input: CreateGlobalBotInput): Promise<GlobalBot> {
      try {
        const row = await prisma.globalBot.create({
          data: {
            slug: input.slug,
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            color: input.color,
            modelProvider: input.modelProvider ?? null,
            modelId: input.modelId ?? null,
            thinkingLevel: input.thinkingLevel ?? null,
            disabledBuiltinTools: input.disabledBuiltinTools,
            publishedAt: input.publish ? new Date() : null,
          },
          include: globalBotInclude,
        });
        return mapGlobalBot(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new IsolationError("Global bot slug already used");
        }
        throw error;
      }
    },

    async updateGlobalBot(input: UpdateGlobalBotInput): Promise<GlobalBot> {
      const { globalBotId, ...patch } = input;
      try {
        const row = await prisma.globalBot.update({
          where: { id: globalBotId },
          data: {
            ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.modelProvider !== undefined ? { modelProvider: patch.modelProvider } : {}),
            ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
            ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
            ...(patch.disabledBuiltinTools !== undefined
              ? { disabledBuiltinTools: patch.disabledBuiltinTools }
              : {}),
          },
          include: globalBotInclude,
        });
        return mapGlobalBot(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new IsolationError("Global bot slug already used");
        if (isNotFound(error)) throw new IsolationError();
        throw error;
      }
    },

    async publishGlobalBot(globalBotId: string, published: boolean): Promise<GlobalBot> {
      try {
        const row = await prisma.globalBot.update({
          where: { id: globalBotId },
          data: { publishedAt: published ? new Date() : null },
          include: globalBotInclude,
        });
        return mapGlobalBot(row);
      } catch (error) {
        if (isNotFound(error)) throw new IsolationError();
        throw error;
      }
    },

    async setGlobalBotConnectors(globalBotId: string, connectorIds: string[]): Promise<GlobalBot> {
      const global = await prisma.globalBot.findUnique({ where: { id: globalBotId } });
      if (!global) throw new IsolationError();
      const uniqueIds = [...new Set(connectorIds)];
      if (uniqueIds.length) {
        const found = await prisma.connector.findMany({
          where: { id: { in: uniqueIds } },
          select: { id: true },
        });
        if (found.length !== uniqueIds.length) throw new IsolationError();
      }
      await prisma.$transaction(async (tx) => {
        await tx.globalBotConnector.deleteMany({ where: { globalBotId } });
        if (uniqueIds.length === 0) return;
        await tx.globalBotConnector.createMany({
          data: uniqueIds.map((connectorId, position) => ({
            globalBotId,
            connectorId,
            position,
          })),
        });
      });
      return loadGlobalBot(globalBotId);
    },

    async listConnectors(): Promise<Connector[]> {
      const rows = await prisma.connector.findMany({
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapConnector);
    },

    async getConnector(connectorId: string): Promise<Connector> {
      const row = await prisma.connector.findUnique({ where: { id: connectorId } });
      if (!row) throw new IsolationError();
      return mapConnector(row);
    },

    async createConnector(input: CreateConnectorInput): Promise<Connector> {
      try {
        const row = await prisma.connector.create({
          data: {
            slug: input.slug,
            name: input.name,
            description: input.description,
            skillRefs: input.skillRefs,
            mcpConfig: (input.mcpConfig ?? {}) as Prisma.InputJsonValue,
            version: input.version,
          },
        });
        return mapConnector(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new IsolationError("Connector slug already used");
        throw error;
      }
    },

    async updateConnector(input: UpdateConnectorInput): Promise<Connector> {
      const { connectorId, ...patch } = input;
      try {
        const row = await prisma.connector.update({
          where: { id: connectorId },
          data: {
            ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.skillRefs !== undefined ? { skillRefs: patch.skillRefs } : {}),
            ...(patch.mcpConfig !== undefined
              ? { mcpConfig: patch.mcpConfig as Prisma.InputJsonValue }
              : {}),
            ...(patch.version !== undefined ? { version: patch.version } : {}),
          },
        });
        return mapConnector(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new IsolationError("Connector slug already used");
        if (isNotFound(error)) throw new IsolationError();
        throw error;
      }
    },

    async removeConnector(connectorId: string): Promise<void> {
      try {
        await prisma.connector.delete({ where: { id: connectorId } });
      } catch (error) {
        if (isNotFound(error)) throw new IsolationError();
        throw error;
      }
    },

    async listSpaceGlobalBots(actor: Actor): Promise<SpaceGlobalBot[]> {
      const [published, enablements, bots] = await Promise.all([
        prisma.globalBot.findMany({
          where: { publishedAt: { not: null } },
          orderBy: [{ name: "asc" }, { createdAt: "asc" }],
        }),
        prisma.spaceGlobalBot.findMany({
          where: { spaceId: actor.spaceId },
        }),
        prisma.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            globalBotId: { not: null },
          },
          select: { id: true, globalBotId: true, archivedAt: true },
        }),
      ]);
      const enabledByGlobal = new Map(enablements.map((row) => [row.globalBotId, row]));
      const botByGlobal = new Map(
        bots
          .filter((bot) => bot.globalBotId && !bot.archivedAt)
          .map((bot) => [bot.globalBotId as string, bot.id]),
      );
      return published.map((global) => {
        const enablement = enabledByGlobal.get(global.id);
        return {
          globalBotId: global.id,
          botId: botByGlobal.get(global.id) ?? null,
          enabled: Boolean(enablement),
          enabledAt: enablement?.enabledAt.toISOString() ?? null,
          slug: global.slug,
          name: global.name,
          title: displayName(global.title, ""),
          description: global.description,
          color: global.color,
          publishedAt: global.publishedAt?.toISOString() ?? null,
        };
      });
    },

    async setSpaceGlobalBotEnabled(
      actor: Actor,
      globalBotId: string,
      enabled: boolean,
    ): Promise<SpaceGlobalBot> {
      const global = await prisma.globalBot.findUnique({ where: { id: globalBotId } });
      if (!global?.publishedAt) throw new IsolationError();

      if (!enabled) {
        await prisma.$transaction(async (tx) => {
          await tx.spaceGlobalBot.deleteMany({
            where: { spaceId: actor.spaceId, globalBotId },
          });
          await tx.bot.updateMany({
            where: {
              spaceId: actor.spaceId,
              globalBotId,
              archivedAt: null,
            },
            data: { archivedAt: new Date() },
          });
        });
        return {
          globalBotId: global.id,
          botId: null,
          enabled: false,
          enabledAt: null,
          slug: global.slug,
          name: global.name,
          title: displayName(global.title, ""),
          description: global.description,
          color: global.color,
          publishedAt: global.publishedAt.toISOString(),
        };
      }

      const enabledAt = new Date();
      const bot = await prisma.$transaction(async (tx) => {
        const materialized = await materializeSpaceBot(tx, actor, global);
        await tx.spaceGlobalBot.upsert({
          where: {
            spaceId_globalBotId: { spaceId: actor.spaceId, globalBotId },
          },
          create: {
            spaceId: actor.spaceId,
            globalBotId,
            enabledByUserId: actor.userId,
            enabledAt,
          },
          update: {
            enabledByUserId: actor.userId,
            enabledAt,
          },
        });
        return materialized;
      });

      return {
        globalBotId: global.id,
        botId: bot.id,
        enabled: true,
        enabledAt: enabledAt.toISOString(),
        slug: global.slug,
        name: global.name,
        title: displayName(global.title, ""),
        description: global.description,
        color: global.color,
        publishedAt: global.publishedAt.toISOString(),
      };
    },

    async getSpacePermissions(actor: Actor): Promise<SpacePermissionsView> {
      const rows = await prisma.spaceRolePermission.findMany({
        where: { spaceId: actor.spaceId },
      });
      const knownRoles = [
        ...new Set([...Object.keys(DEFAULT_ROLE_PERMISSIONS), ...rows.map((row) => row.role)]),
      ].sort();
      return {
        roles: knownRoles.map((role) => {
          const overridden = rows.some((row) => row.role === role);
          const permissions = [...permissionsForRole(role, rows)].sort() as SpacePermission[];
          return { role, permissions, overridden };
        }),
      };
    },

    async setSpacePermissions(
      actor: Actor,
      input: SetSpacePermissionsInput,
    ): Promise<SpacePermissionsView> {
      const valid = new Set<string>(SpacePermissionSchema.options);
      for (const entry of input.roles) {
        for (const permission of entry.permissions) {
          if (!valid.has(permission)) throw new IsolationError();
        }
      }
      await prisma.$transaction(async (tx) => {
        const roles = [...new Set(input.roles.map((entry) => entry.role))];
        if (roles.length) {
          await tx.spaceRolePermission.deleteMany({
            where: { spaceId: actor.spaceId, role: { in: roles } },
          });
        }
        const data = input.roles.flatMap((entry) =>
          entry.permissions.map((permission) => ({
            spaceId: actor.spaceId,
            role: entry.role,
            permission,
          })),
        );
        if (data.length) await tx.spaceRolePermission.createMany({ data });
      });
      return this.getSpacePermissions(actor);
    },
  };
}

export type GlobalBotRepos = ReturnType<typeof createGlobalBotRepos>;

/** Visible in `bots.list`: the caller's personal bots plus enabled Global instances. */
export function botRosterWhere(
  actor: Actor,
  options: { archived?: boolean } = {},
): Prisma.BotWhereInput {
  const archivedAt = options.archived ? { not: null } : null;
  if (options.archived) {
    return {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt,
    };
  }
  // Disabled globals are archived on setEnabled(false), so active shared rows are enough.
  return {
    spaceId: actor.spaceId,
    archivedAt,
    OR: [{ userId: actor.userId }, { userId: null, globalBotId: { not: null } }],
  };
}
