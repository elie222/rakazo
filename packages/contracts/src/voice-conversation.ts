import * as z from "zod";

export const VoiceConversationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected"), answerSdp: z.string().max(65536) }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({
    type: z.literal("transcript"),
    id: z.string().max(200),
    role: z.enum(["user", "bot"]),
    text: z.string().max(20000),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
  }),
  z.object({ type: z.literal("delegation"), id: z.string().max(200) }),
  z.object({ type: z.literal("error"), message: z.string().max(1000) }),
  z.object({ type: z.literal("closed") }),
]);
export type VoiceConversationEvent = z.infer<typeof VoiceConversationEventSchema>;
