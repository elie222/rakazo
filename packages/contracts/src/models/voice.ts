import * as z from "zod";
import { Id } from "../ids.js";

export const MAX_TRANSCRIPTION_VOCABULARY_LENGTH = 500;

export const VoiceCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  transcribe: z.boolean(),
  /** The connection accepts vocabulary hints for transcription. */
  transcriptionVocabulary: z.boolean().optional(),
  keyless: z.boolean().optional(),
  /** The connection takes an optional speech model id that overrides the provider default. */
  speechModel: z.boolean().optional(),
  /**
   * The account's model connection to this provider can authenticate voice, so the key is
   * optional. Set only for an account that has one.
   */
  modelConnection: z.boolean().optional(),
  /** The account's model connections to this provider that voice can use instead of a key. */
  modelConnections: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  /**
   * The Models sign-in button text for this provider, when voice can use a sign-in and the
   * account has no model connection to it yet. Signing in adds one.
   */
  modelSignIn: z.string().optional(),
  /** The provider can list its voices for one language, so the picker may offer a filter. */
  languages: z.boolean().optional(),
  /** The provider lists its speech models, so the model field can suggest them. */
  speechModels: z.boolean().optional(),
  /** A voice id can be typed, because a model's voices may be missing from its listing. */
  freeformVoice: z.boolean().optional(),
});
export type VoiceCatalogEntry = z.infer<typeof VoiceCatalogEntrySchema>;

export const VoiceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Lowercase language codes the voice speaks, such as "en" or "de", when the provider says. */
  languages: z.array(z.string()).optional(),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

export const VoiceModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type VoiceModelInfo = z.infer<typeof VoiceModelInfoSchema>;

export const VoiceCredentialSchema = z.object({
  id: Id,
  provider: z.string(),
  /** False when the connection authenticates with the account's model connection instead. */
  hasKey: z.boolean(),
  /** The model connection a connection without a key uses, when it names one. */
  modelCredentialId: z.string().optional(),
  isDefault: z.boolean(),
  voiceId: z.string(),
  /** Fish speech-model override. Empty uses the deployment default. */
  speechModel: z.string(),
  transcribe: z.boolean(),
  /** Self-hosted server base URL and model ids (never the key). Empty for hosted providers. */
  endpoint: z.string().default(""),
  /** A separate self-hosted transcription server; empty when `endpoint` transcribes. */
  sttEndpoint: z.string().default(""),
  ttsModel: z.string().default(""),
  sttModel: z.string().default(""),
  transcriptionVocabulary: z.string().optional(),
});
export type VoiceCredential = z.infer<typeof VoiceCredentialSchema>;

export const VoiceStatusSchema = z.object({
  configured: z.boolean(),
  ready: z.boolean(),
  transcribe: z.boolean(),
  provider: z.string().nullable(),
  voiceId: z.string(),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;
