import type { ConnectorTool } from "@rakazo/adapter-kit";
import { z } from "zod";

export const READ_MEETING_TRANSCRIPT = "read_meeting_transcript";

export const meetingTranscriptArgs = z.object({
  meeting_id: z.string().min(1).max(128).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  before: z
    .object({ ended_at: z.iso.datetime(), meeting_id: z.string().min(1).max(128) })
    .optional(),
});

export const meetingTranscriptTool: ConnectorTool = {
  name: READ_MEETING_TRANSCRIPT,
  description:
    "Read a meeting transcript when the user asks about what was said. Pass meeting_id from recent_bot_meetings or a list result. For more transcript text, pass next_offset as offset. To find earlier meetings, omit meeting_id to list shared transcripts, then pass next_before as before to continue the list.",
  inputSchema: z.toJSONSchema(meetingTranscriptArgs, { io: "input" }),
  readOnly: true,
};
