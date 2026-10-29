import { ORPCError } from "@orpc/server";
import type { Actor, SpaceNavigation } from "@rakazo/contracts";
import type { createGroupRepos, createRepos, PrismaClient } from "@rakazo/db";
import {
  CannotDeleteDefaultSpaceError,
  CannotDeleteLastSpaceError,
  CannotDeleteSpaceAsNonOwnerError,
  CannotRenameSpaceAsNonOwnerError,
  createExternalConversationRepos,
  createSpaceForMember,
  InvalidSpaceNameError,
  IsolationError,
  renameSpaceForMember,
  runAsSystem,
  runAsTenant,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  SpaceLimitError,
  SpaceNotFoundError,
  setSpaceSettingOverride,
  spaceSettingOverrides,
} from "@rakazo/db";
import type { RouterDeps } from "../router.js";
import { listRoutinesDto } from "../routines.js";
import { deleteSpaceWithContent } from "../space-deletion.js";
import { resolveThreadTarget, threadSnapshot } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { meDto } from "./shared.js";

/**
 * Runs `fn` scoped to another of the actor's Spaces. Membership is checked first,
 * so a client-supplied Space id never opens that Space's rows on its own.
 */
async function asMemberOf<T>(
  prisma: PrismaClient,
  actor: Actor,
  spaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const member = await prisma.spaceMember.findFirst({
    where: { spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!member) throw new ORPCError("NOT_FOUND", { message: new SpaceNotFoundError().message });
  return runAsTenant({ spaceId, userId: actor.userId }, fn);
}

export function spacesRoutes(ctx: RouterContext) {
  const { deps, repos, groupRepos, authed } = ctx;
  return {
    spaceSettings: {
      overrides: authed.spaceSettings.overrides.handler(({ context }) =>
        spaceSettingOverrides(deps.prisma, context.actor),
      ),
      setOverride: authed.spaceSettings.setOverride.handler(({ context, input }) =>
        setSpaceSettingOverride(deps.prisma, context.actor, input.setting, input.enabled),
      ),
    },
    spaces: {
      list: authed.spaces.list.handler(async ({ context }) =>
        spaceNavigationDto(deps, context.actor, repos, groupRepos),
      ),
      // Seeds a Space whose id does not exist yet; the member limit is checked inside.
      create: authed.spaces.create.handler(({ context, input }) =>
        runAsSystem("create a Space for its member", async () => {
          let space: { id: string; name: string };
          try {
            space = await createSpaceForMember(deps.prisma, {
              currentSpaceId: context.actor.spaceId,
              userId: context.actor.userId,
              name: input.name,
            });
          } catch (error) {
            if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw error;
          }
          return {
            id: space.id,
            name: space.name,
            isDefault: false,
            hasContent: false,
            canRename: true,
            canDelete: true,
            botCount: 0,
            bots: [],
            groups: [],
            externalConversations: [],
            botSections: [],
          };
        }),
      ),
      // Renames another of the member's Spaces; membership is checked inside.
      rename: authed.spaces.rename.handler(({ context, input }) =>
        asMemberOf(deps.prisma, context.actor, input.spaceId, async () => {
          try {
            return await renameSpaceForMember(deps.prisma, {
              currentSpaceId: context.actor.spaceId,
              userId: context.actor.userId,
              spaceId: input.spaceId,
              name: input.name,
            });
          } catch (error) {
            if (error instanceof SpaceNotFoundError) {
              throw new ORPCError("NOT_FOUND", { message: error.message });
            }
            if (error instanceof CannotRenameSpaceAsNonOwnerError) {
              throw new ORPCError("FORBIDDEN", { message: error.message });
            }
            if (error instanceof InvalidSpaceNameError) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            if (error instanceof SpaceDeletionInProgressError) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            throw error;
          }
        }),
      ),
      // Acts on the Space being deleted, not the current one, so its teardown sees
      // that Space's rows. Ownership is checked inside.
      remove: authed.spaces.remove.handler(({ context, input }) =>
        asMemberOf(deps.prisma, context.actor, input.spaceId, async () => {
          try {
            const { activeSpaceId } = await deleteSpaceWithContent(
              deps,
              context.actor,
              input.spaceId,
              context.signal,
            );
            return { ok: true as const, activeSpaceId };
          } catch (error) {
            if (error instanceof SpaceNotFoundError) {
              throw new ORPCError("NOT_FOUND", { message: error.message });
            }
            if (error instanceof CannotDeleteSpaceAsNonOwnerError) {
              throw new ORPCError("FORBIDDEN", { message: error.message });
            }
            if (error instanceof SpaceDeletionInProgressError) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            if (
              error instanceof CannotDeleteDefaultSpaceError ||
              error instanceof CannotDeleteLastSpaceError
            ) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw error;
          }
        }),
      ),
    },
    bootstrap: authed.bootstrap.handler(async ({ context, input }) => {
      const actor = context.actor;
      const [me, navigation, archivedBots, archivedGroups] = await Promise.all([
        meDto(deps, actor),
        spaceNavigationDto(deps, actor, repos, groupRepos),
        repos.listBots(actor, { archived: true }),
        groupRepos.listGroups(actor, { archived: true }),
      ]);
      const { bots, groups, botSections } = navigation.current;
      const active = bots.find((bot) => bot.id === input.botId) ?? bots[0];
      const [thread, routines] = active
        ? await Promise.all([
            resolveThreadTarget(deps.prisma, actor, { botId: active.id }).then((target) =>
              threadSnapshot(deps, target),
            ),
            listRoutinesDto(deps, actor, active.id),
          ])
        : [null, []];
      return {
        me,
        bots,
        groups,
        botSections,
        archivedBots,
        archivedGroups,
        thread,
        routines,
        spaces: navigation.spaces,
      };
    }),
  };
}

// Lists every Space the member belongs to, with each one's bots and threads, so it
// reads across Spaces. Every query below is limited to the member's Spaces.
function spaceNavigationDto(
  deps: RouterDeps,
  actor: Actor,
  repos: ReturnType<typeof createRepos>,
  groupRepos: ReturnType<typeof createGroupRepos>,
): Promise<SpaceNavigation> {
  return runAsSystem("space navigation across the member's Spaces", () =>
    memberSpaceNavigation(deps, actor, repos, groupRepos),
  );
}

async function memberSpaceNavigation(
  deps: RouterDeps,
  actor: Actor,
  repos: ReturnType<typeof createRepos>,
  groupRepos: ReturnType<typeof createGroupRepos>,
): Promise<SpaceNavigation> {
  const currentSpace = await deps.prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: { organizationId: true },
  });
  if (!currentSpace) throw new IsolationError();
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: actor.userId, organizationId: currentSpace.organizationId },
    select: {
      spaceId: true,
      role: true,
      space: { select: { name: true, isDefault: true, deletingAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const spaceIds = memberships.map((membership) => membership.spaceId);
  const inactiveSpaceIds = spaceIds.filter((spaceId) => spaceId !== actor.spaceId);
  const [
    currentBots,
    currentGroups,
    inactiveBots,
    inactiveGroups,
    botSections,
    externalConversations,
    contentBots,
    contentGroups,
  ] = await Promise.all([
    repos.listBots(actor),
    groupRepos.listGroups(actor),
    repos.listSpaceBotsForSpaces(actor, inactiveSpaceIds),
    groupRepos.listSpaceGroupsForSpaces(actor, inactiveSpaceIds),
    repos.listBotSectionsForSpaces(actor, spaceIds),
    createExternalConversationRepos(deps.prisma).listForSpaces(actor, spaceIds),
    // Active-only navigation lists miss archived content in other spaces; count any
    // bot/group in the actor's spaces (including another member's) so a shared
    // non-empty space cannot look empty for onboarding redirects.
    deps.prisma.bot.groupBy({
      by: ["spaceId"],
      where: { spaceId: { in: spaceIds } },
      _count: { _all: true },
    }),
    deps.prisma.chatGroup.findMany({
      where: { spaceId: { in: spaceIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    }),
  ]);
  const botCounts = new Map(contentBots.map((row) => [row.spaceId, row._count._all]));
  const spacesWithContent = new Set([
    ...contentBots.map((row) => row.spaceId),
    ...contentGroups.map((row) => row.spaceId),
  ]);
  const currentMembership = memberships.find((membership) => membership.spaceId === actor.spaceId);
  if (!currentMembership) throw new IsolationError();
  const botsBySpace = partitionBySpace([...currentBots, ...inactiveBots]);
  const groupsBySpace = partitionBySpace([...currentGroups, ...inactiveGroups]);
  const sectionsBySpace = partitionBySpace(botSections);
  const botsFor = (spaceId: string) => botsBySpace.get(spaceId) ?? [];
  const groupsFor = (spaceId: string) => groupsBySpace.get(spaceId) ?? [];
  const sectionsFor = (spaceId: string) => sectionsBySpace.get(spaceId) ?? [];
  const staleClaimBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);

  return {
    current: {
      id: actor.spaceId,
      name: currentMembership.space.name,
      bots: currentBots,
      groups: currentGroups,
      externalConversations: externalConversations.filter(
        (conversation) => conversation.spaceId === actor.spaceId,
      ),
      botSections: sectionsFor(actor.spaceId),
    },
    spaces: memberships.map((membership) => {
      const spaceBots = botsFor(membership.spaceId);
      const spaceGroups = groupsFor(membership.spaceId);
      return {
        id: membership.spaceId,
        name: membership.space.name,
        isDefault: membership.space.isDefault,
        hasContent: spacesWithContent.has(membership.spaceId),
        botCount: botCounts.get(membership.spaceId) ?? 0,
        canRename: membership.role === "owner" && membership.space.deletingAt === null,
        canDelete:
          membership.role === "owner" &&
          !membership.space.isDefault &&
          memberships.length > 1 &&
          (membership.space.deletingAt === null || membership.space.deletingAt < staleClaimBefore),
        bots: spaceBots.map((bot) => ({
          id: bot.id,
          parentBotId: bot.parentBotId,
          spaceId: bot.spaceId,
          name: bot.name,
          title: "",
          color: bot.color,
          avatarSet: bot.avatarSet,
          notifyOnFinish: bot.notifyOnFinish,
          pinned: bot.pinned,
          sectionId: bot.sectionId,
          unread: bot.unread,
          preview: bot.preview,
          status: bot.status,
          runErrorId: bot.runErrorId,
          updatedAt: bot.updatedAt,
        })),
        groups: spaceGroups.map((group) => ({
          id: group.id,
          spaceId: group.spaceId,
          name: group.name,
          pinned: group.pinned,
          sectionId: group.sectionId,
          members: group.members,
          preview: group.preview,
          unread: group.unread,
          updatedAt: group.updatedAt,
        })),
        externalConversations: externalConversations.filter(
          (conversation) => conversation.spaceId === membership.spaceId,
        ),
        botSections: sectionsFor(membership.spaceId),
      };
    }),
  };
}

function partitionBySpace<T extends { spaceId: string }>(rows: T[]): Map<string, T[]> {
  const partitioned = new Map<string, T[]>();
  for (const row of rows) {
    const spaceRows = partitioned.get(row.spaceId) ?? [];
    spaceRows.push(row);
    partitioned.set(row.spaceId, spaceRows);
  }
  return partitioned;
}
