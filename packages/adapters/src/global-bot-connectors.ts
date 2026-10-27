import type { SpacePermission } from "@rakazo/contracts";
import { parseConnectorMcpConfig } from "@rakazo/contracts";
import { connectorToolRequiresApproval, type SkillRecord } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { hasPermission, permissionsForRole, type RolePermissionRow } from "@rakazo/db";
import { listAgentSkillRecords } from "./skill-tools.js";

export type GlobalBotConnectorPack = {
  id: string;
  slug: string;
  name: string;
  skillRefs: string[];
  mcpConfig: unknown;
  position: number;
};

export type GlobalBotPackMcpAccess = {
  serverId: string;
  slug: string;
  allowAllTools: boolean;
  allowedTools: string[];
  /** Connector pack that bound this server. */
  connectorId: string;
  connectorSlug: string;
};

/** Attached Connector packs for a catalog Global bot, ordered by attach position. */
export async function loadGlobalBotConnectorPacks(
  prisma: PrismaClient,
  globalBotId: string,
): Promise<GlobalBotConnectorPack[]> {
  const links = await prisma.globalBotConnector.findMany({
    where: { globalBotId },
    include: {
      connector: {
        select: {
          id: true,
          slug: true,
          name: true,
          skillRefs: true,
          mcpConfig: true,
        },
      },
    },
    orderBy: [{ position: "asc" }, { connectorId: "asc" }],
  });
  return links.map((link) => ({
    id: link.connector.id,
    slug: link.connector.slug,
    name: link.connector.name,
    skillRefs: Array.isArray(link.connector.skillRefs)
      ? link.connector.skillRefs.filter((ref): ref is string => typeof ref === "string")
      : [],
    mcpConfig: link.connector.mcpConfig,
    position: link.position,
  }));
}

/**
 * Resolve space MCP servers named by Connector packs.
 * Prefers the chatting user's server for a slug, else any enabled server in the space.
 */
export async function resolveGlobalBotPackMcpAccess(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; packs: GlobalBotConnectorPack[] },
): Promise<GlobalBotPackMcpAccess[]> {
  const wanted = new Map<
    string,
    { connectorId: string; connectorSlug: string; allowedTools?: string[] }
  >();
  for (const pack of input.packs) {
    const config = parseConnectorMcpConfig(pack.mcpConfig);
    for (const slug of config.serverSlugs) {
      if (wanted.has(slug)) continue;
      wanted.set(slug, {
        connectorId: pack.id,
        connectorSlug: pack.slug,
        allowedTools: config.allowedToolsBySlug?.[slug],
      });
    }
  }
  if (wanted.size === 0) return [];
  const slugs = [...wanted.keys()];
  const servers = await prisma.mcpServer.findMany({
    where: {
      spaceId: input.spaceId,
      slug: { in: slugs },
      enabled: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  const bySlug = new Map<string, (typeof servers)[number]>();
  for (const server of servers) {
    const existing = bySlug.get(server.slug);
    if (!existing) {
      bySlug.set(server.slug, server);
      continue;
    }
    // Prefer the chatting user's own server when several members share a slug.
    if (existing.userId !== input.userId && server.userId === input.userId) {
      bySlug.set(server.slug, server);
    }
  }
  const access: GlobalBotPackMcpAccess[] = [];
  for (const [slug, bind] of wanted) {
    const server = bySlug.get(slug);
    if (!server) continue;
    const allowedTools = bind.allowedTools ?? [];
    access.push({
      serverId: server.id,
      slug,
      allowAllTools: allowedTools.length === 0,
      allowedTools,
      connectorId: bind.connectorId,
      connectorSlug: bind.connectorSlug,
    });
  }
  return access;
}

/** Skill catalog entries named by Connector packs (matched in the caller's space skills). */
export async function resolveGlobalBotPackSkills(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string },
  packs: GlobalBotConnectorPack[],
): Promise<Array<SkillRecord & { id: string }>> {
  const refs = [
    ...new Set(packs.flatMap((pack) => pack.skillRefs.map((ref) => ref.trim()).filter(Boolean))),
  ];
  if (refs.length === 0) return [];
  const skills = await listAgentSkillRecords(prisma, owner);
  const matched: Array<SkillRecord & { id: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const skill =
      skills.find((row) => row.id === ref) ??
      skills.find((row) => row.name.toLowerCase() === ref.toLowerCase());
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    matched.push(skill);
  }
  return matched;
}

export async function loadSpaceActorPermissions(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
): Promise<{ role: string; permissions: Set<SpacePermission> }> {
  const [membership, overrides] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { role: true },
    }),
    prisma.spaceRolePermission.findMany({
      where: { spaceId: actor.spaceId },
      select: { role: true, permission: true },
    }),
  ]);
  const role = membership?.role ?? "member";
  return {
    role,
    permissions: permissionsForRole(role, overrides as RolePermissionRow[]),
  };
}

/** Permission required to call a connector tool on a Global bot. */
export function connectorToolPermissionNeeded(
  toolName: string,
  readOnly?: boolean,
): SpacePermission {
  return connectorToolRequiresApproval(toolName, readOnly) ? "finance.write" : "finance.read";
}

export function actorHasConnectorToolPermission(
  actor: { role: string },
  permission: SpacePermission,
  overrides?: Iterable<RolePermissionRow> | null,
): boolean {
  return hasPermission(
    {
      userId: "run",
      spaceId: "run",
      email: "run@example.test",
      isDeploymentOwner: false,
      role: actor.role,
    },
    permission,
    overrides,
  );
}

export function denyConnectorToolMessage(toolName: string, permission: SpacePermission): string {
  return permission === "finance.write"
    ? `${toolName} needs finance.write in this space. Ask a space owner to grant write access, or use a read-only tool.`
    : `${toolName} needs finance.read in this space. Ask a space owner to grant access.`;
}
