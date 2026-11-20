import { voiceCatalogEntry } from "@rakazo/adapters";
import type { VoiceCredential } from "@rakazo/contracts";

export function toVoiceCredential(row: {
  id: string;
  provider: string;
  isDefault: boolean;
  voiceId: string;
  speechModel?: string | null;
  server?: { endpoint: string; sttEndpoint: string; ttsModel: string; sttModel: string };
  /** False when the connection uses the account's model connection instead of a key. */
  hasKey?: boolean;
}): VoiceCredential {
  return {
    id: row.id,
    provider: row.provider,
    hasKey: row.hasKey ?? true,
    isDefault: row.isDefault,
    voiceId: row.voiceId,
    speechModel: row.speechModel ?? "",
    transcribe: Boolean(voiceCatalogEntry(row.provider)?.transcribe),
    endpoint: row.server?.endpoint ?? "",
    sttEndpoint: row.server?.sttEndpoint ?? "",
    ttsModel: row.server?.ttsModel ?? "",
    sttModel: row.server?.sttModel ?? "",
  };
}
