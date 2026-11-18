import type { Message, Prisma, PrismaClient } from "@rakazo/db";
import { mayBeChannelMessage } from "@rakazo/db";
import { meetingTranscriptText, readMeetingTurns } from "./meeting-transcript.js";

type MeetingChat = { spaceId: string; botId: string };
type EarlierMeetingCursor = { ended_at: string; meeting_id: string };
const meetingOrder = [
  { closedAt: "desc" },
  { id: "desc" },
] satisfies Prisma.MeetingSessionOrderByWithRelationInput[];
const meetingSummary = {
  id: true,
  platform: true,
  closedAt: true,
  status: true,
  sharedArtifact: { select: { name: true } },
} satisfies Prisma.MeetingSessionSelect;
type MeetingChatThread = {
  id: string;
  botId: string | null;
  groupId: string | null;
  externalConversationId: string | null;
};

export function isMeetingChat(
  run: MeetingChat & { trigger: string },
  thread: MeetingChatThread,
  source: Pick<Message, "id" | "role" | "threadId" | "blocks"> | null,
) {
  return (
    thread.botId === run.botId &&
    !thread.groupId &&
    !thread.externalConversationId &&
    (run.trigger === "user" ||
      (run.trigger === "follow_up" &&
        source?.role === "user" &&
        source.threadId === thread.id &&
        !mayBeChannelMessage(source)))
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
  const latest = await prisma.meetingSession.findMany({
    where: completedMeetings(chat),
    select: meetingSummary,
    orderBy: meetingOrder,
    take: 5,
  });
  if (latest.length < 5 || latest.some(({ status }) => status === "ready")) return latest;
  const olderReady = await prisma.meetingSession.findFirst({
    where: {
      ...completedMeetings(chat),
      status: "ready",
      id: { notIn: latest.map(({ id }) => id) },
    },
    select: meetingSummary,
    orderBy: meetingOrder,
  });
  return olderReady ? [...latest, olderReady] : latest;
}

export async function listChatTranscripts(
  prisma: Pick<PrismaClient, "meetingSession">,
  chat: MeetingChat,
  before?: EarlierMeetingCursor,
) {
  const endedAt = before && new Date(before.ended_at);
  const records = await prisma.meetingSession.findMany({
    where: {
      ...completedMeetings(chat),
      status: "ready",
      ...(before &&
        endedAt && {
          OR: [{ closedAt: { lt: endedAt } }, { closedAt: endedAt, id: { lt: before.meeting_id } }],
        }),
    },
    select: { id: true, platform: true, closedAt: true },
    orderBy: meetingOrder,
    take: 11,
  });
  const meetings = records.slice(0, 10).map(({ id, platform, closedAt }) => ({
    meeting_id: id,
    platform,
    ended_at: closedAt!.toISOString(),
  }));
  const last = meetings.at(-1);
  return {
    meetings,
    next_before:
      records.length > meetings.length && last
        ? { ended_at: last.ended_at, meeting_id: last.meeting_id }
        : null,
  };
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
