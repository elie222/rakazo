import { createHash } from "node:crypto";
import type { MeetingTurn } from "@rakazo/contracts";
import { MeetingTurnSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { JsonColumnMismatchError, readJsonColumn, reportJsonColumnOnce } from "@rakazo/db";

export const MEETING_TRANSCRIPT_STORAGE_PREFIX = "meeting-transcript:";

export function meetingTranscriptStorageKey(id: string) {
  return MEETING_TRANSCRIPT_STORAGE_PREFIX + id;
}

export function meetingTranscriptArtifact(
  row: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    createdAt: Date;
    closedAt: Date | null;
  },
  turns: MeetingTurn[],
) {
  const text = meetingTranscriptText(turns);
  const time = (row.closedAt ?? row.createdAt).toISOString().slice(0, 16).replace("T", " ");
  return {
    spaceId: row.spaceId,
    userId: row.userId,
    botId: row.botId,
    name: `Meeting transcript ${time} UTC.txt`,
    mimeType: "text/plain",
    size: Buffer.byteLength(text),
    hash: createHash("sha256").update(text).digest("hex"),
    storageKey: meetingTranscriptStorageKey(row.id),
    meetingSessionId: row.id,
    standalone: true,
  };
}

export function readMeetingTurns(id: string, transcript: string) {
  const row = { table: "meeting_sessions", column: "transcript", id };
  try {
    let value: unknown;
    try {
      value = JSON.parse(transcript);
    } catch (error) {
      if (error instanceof SyntaxError) throw new JsonColumnMismatchError(row);
      throw error;
    }
    return readJsonColumn(MeetingTurnSchema.array(), value, row, "reject");
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    reportJsonColumnOnce("Stored meeting transcript is invalid", error.row);
    throw new ClientError("SERVICE_UNAVAILABLE", "This transcript couldn’t be read.");
  }
}

export function meetingTranscriptText(turns: readonly MeetingTurn[]) {
  return turns
    .map(({ speaker, startMs, text }) => {
      const seconds = Math.floor(startMs / 1_000);
      return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}] ${speaker}: ${text}`;
    })
    .join("\n");
}
