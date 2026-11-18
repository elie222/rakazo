import { oc } from "@orpc/contract";
import { z } from "zod";

// The service that hosts the meeting. Product labels live in core's meeting platform catalog.
export const MeetingPlatformSchema = z.enum(["zoom", "google_meet", "microsoft_teams"]);
export type MeetingPlatform = z.infer<typeof MeetingPlatformSchema>;

export const MeetingStatusSchema = z.enum([
  "scheduled",
  "joining",
  "waiting",
  "joined",
  "leaving",
  "processing",
  "ready",
  "failed",
  "ended",
]);
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

export function canLeaveMeeting(status: MeetingStatus): boolean {
  return status === "joining" || status === "waiting" || status === "joined";
}

export const MeetingTurnSchema = z.object({
  speaker: z.string().max(256),
  startMs: z.number().int().nonnegative(),
  text: z.string().max(32_000),
});
export type MeetingTurn = z.infer<typeof MeetingTurnSchema>;

const meeting = z.object({
  id: z.string(),
  platform: MeetingPlatformSchema,
  status: MeetingStatusSchema,
  createdAt: z.number(),
  transcriptAvailable: z.boolean(),
  error: z.string().optional(),
});

const session = z.object({ id: z.string().min(1).max(128) });
const bot = z.object({ botId: z.string().min(1).max(128) });
const transcript = z.object({
  turns: z.array(MeetingTurnSchema),
  artifactAvailable: z.boolean().optional(),
});

export const meetingsRpc = {
  meetings: {
    list: oc.input(bot).output(z.object({ enabled: z.boolean(), meetings: z.array(meeting) })),
    join: oc
      .input(
        bot.extend({ url: z.string().min(1).max(2048), shareTranscript: z.boolean().optional() }),
      )
      .output(z.void()),
    leave: oc.input(session).output(z.void()),
    transcript: oc.input(session).output(transcript),
    shareTranscript: oc.input(session).output(z.void()),
    deleteTranscript: oc.input(session).output(z.void()),
    /**
     * @deprecated Ask in the bot's chat on current clients. Keep this until supported
     * mobile runtimes can all receive a client that no longer calls it.
     */
    ask: oc
      .input(session.extend({ question: z.string().trim().min(1).max(4000) }))
      .output(z.object({ answer: z.string() })),
  },
};
