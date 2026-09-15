import * as z from "zod";

export const AI_DISCLOSURE_VERSION = "2026-09-14";
export const AI_PRIVACY_URL = "https://rakazo.com/privacy/";
export const AiDataUseSchema = z.enum(["model", "voice", "memory"]);
export type AiDataUse = z.infer<typeof AiDataUseSchema>;
export const AI_DATA_DISCLOSURES: Record<AiDataUse, string> = {
  model:
    "Messages, relevant conversation history, bot instructions, memories, attachments, screenshots, and connected-app content used by your bots are sent to generate responses and carry out tasks, including scheduled tasks.",
  voice:
    "Audio you record is sent for transcription. Text you choose to play, including bot responses, is sent to generate speech.",
  memory:
    "Conversation summaries, saved memories, search queries, and bot and Space identifiers are sent to store and retrieve context for your bots.",
};
export const AiConsentQuerySchema = z
  .object({
    botId: z.string().optional(),
    groupId: z.string().optional(),
    uses: z.array(AiDataUseSchema).optional(),
  })
  .default({});
export type AiConsentQuery = z.infer<typeof AiConsentQuerySchema>;
export const AiRecipientSchema = z.object({
  key: z.string(),
  name: z.string(),
  use: AiDataUseSchema,
  detail: z.string(),
  privacyUrl: z.string().url().optional(),
  allowed: z.boolean(),
});
export type AiRecipient = z.infer<typeof AiRecipientSchema>;
export const AiConsentStatusSchema = z.object({
  scope: z.string(),
  version: z.string(),
  recipients: z.array(AiRecipientSchema),
  privacyUrl: z.string().url().optional(),
});
export type AiConsentStatus = z.infer<typeof AiConsentStatusSchema>;
export const AI_CONSENT_REQUIRED = "Review AI data sharing in Account settings before continuing.";
