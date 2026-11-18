import type { ConnectorTool } from "@rakazo/adapter-kit";
import { z } from "zod";

export const READ_MEETING_TRANSCRIPT = "read_meeting_transcript";

export const meetingTranscriptArgs = z.object({
  meeting_id: z.string().min(1).max(128),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export const meetingTranscriptTool: ConnectorTool = {
  name: READ_MEETING_TRANSCRIPT,
  description:
    "Read a meeting transcript when the user asks about what was said. Pass the meeting ID from recent_bot_meetings. Continue with next_offset if you need more of the transcript.",
  inputSchema: z.toJSONSchema(meetingTranscriptArgs, { io: "input" }),
  readOnly: true,
};
