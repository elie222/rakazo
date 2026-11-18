import type { Prisma, PrismaClient } from "@rakazo/db";
import { meetingTranscriptText, readMeetingTurns } from "./meeting-transcript.js";

type MeetingChat = { spaceId: string; botId: string };
type MeetingChatThread = {
  botId: string | null;
  groupId: string | null;
  externalConversationId: string | null;
};

export function isMeetingChat(run: MeetingChat & { trigger: string }, thread: MeetingChatThread) {
  return (
    run.trigger === "user" &&
    thread.botId === run.botId &&
    !thread.groupId &&
    !thread.externalConversationId
  );
}

function completedMeetings(chat: MeetingChat): Prisma.MeetingSessionWhereInput {
  return {
    spaceId: chat.spaceId,
    botId: chat.botId,
    shareTranscript: true,
    closedAt: { not: null },
    status: { in: ["processing", "ready"] },
  };
}

export async function recentChatMeetings(
  prisma: Pick<PrismaClient, "meetingSession">,
  chat: MeetingChat,
) {
  return prisma.meetingSession.findMany({
    where: completedMeetings(chat),
    select: {
      id: true,
      platform: true,
      closedAt: true,
      status: true,
      sharedArtifact: { select: { name: true } },
    },
    orderBy: [{ closedAt: "desc" }, { id: "desc" }],
    take: 5,
  });
}

export async function readChatMeeting(
  prisma: Pick<PrismaClient, "meetingSession">,
  chat: MeetingChat,
  id: string,
  offset: number,
) {
  const meeting = await prisma.meetingSession.findFirst({
    where: { ...completedMeetings(chat), id, status: "ready" },
    select: { id: true, transcript: true },
  });
  if (meeting?.transcript == null) return null;
  const transcript = meetingTranscriptText(readMeetingTurns(meeting.id, meeting.transcript));
  const end = offset + 8_000;
  return {
    transcript: transcript.slice(offset, end),
    next_offset: end < transcript.length ? end : null,
  };
}
