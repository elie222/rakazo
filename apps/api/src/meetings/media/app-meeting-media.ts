import type { configuredMeetingMedia } from "@rakazo/adapters/meeting-media";
import { memberHasModelAccess, runAsSystem, runAsTenant } from "@rakazo/db";
import { createMeetingMedia, meetingVoiceReady } from "./meeting-media.js";

type MediaDeps = Parameters<typeof createMeetingMedia>[0];

export function appMeetingMedia(
  deps: Omit<MediaDeps, "signingSecret" | "publicOrigin" | "loadSession" | "voiceReady"> & {
    config: NonNullable<ReturnType<typeof configuredMeetingMedia>>;
    providerId: string;
    enabled: (spaceId: string) => boolean;
    billingEnabled: boolean;
  },
) {
  const { prisma, config, providerId, enabled } = deps;
  return createMeetingMedia({
    ...deps,
    ...config,
    voiceReady: async ({ actor, botId }, signal) =>
      (!deps.billingEnabled ||
        (await runAsTenant(actor, () => memberHasModelAccess(prisma, actor)))) &&
      (await meetingVoiceReady(deps, actor, botId, signal)),
    loadSession: async (id) => {
      const session = await runAsSystem("resolve signed meeting media", async () => {
        const row = await prisma.meetingSession.findFirst({
          where: {
            id,
            provider: providerId,
            status: { in: ["scheduled", "joining", "waiting", "joined"] },
            closedAt: null,
            expiresAt: { gt: new Date() },
            bot: { archivedAt: null },
            user: { deactivatedAt: null },
          },
          select: {
            user: { select: { email: true } },
            userId: true,
            spaceId: true,
            botId: true,
            bot: { select: { name: true } },
            status: true,
          },
        });
        if (!row || !enabled(row.spaceId)) return null;
        const member = await prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: row.spaceId, userId: row.userId } },
          select: { id: true },
        });
        return member ? row : null;
      });
      if (!session) return null;
      const actor = {
        spaceId: session.spaceId,
        userId: session.userId,
        email: session.user.email,
        isDeploymentOwner: false,
      };
      return {
        actor,
        botId: session.botId,
        botName: session.bot.name,
        admitted: session.status === "joined",
        voice: config.voice,
      };
    },
  });
}
