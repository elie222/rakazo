import { createHmac } from "node:crypto";
import { AES_GCM_OVERHEAD_BYTES, openAesGcm, sealAesGcm } from "@rakazo/core/node/aes-gcm";

const MAX_CONTEXT_BYTES = 1_600;
const MAX_TOKEN_LENGTH = Math.ceil(((MAX_CONTEXT_BYTES + AES_GCM_OVERHEAD_BYTES) * 4) / 3);

/**
 * The transient camera page carries a sealed, size-limited window of the conversation.
 * Any API replica can resume it. It stays out of storage and expires with the media grant.
 */
export function meetingTurnContext(signingSecret: string) {
  const key = createHmac("sha256", signingSecret).update("meeting-media/context/v1").digest();

  return {
    seal(text: string, grant: string) {
      const bytes = Buffer.from(text).subarray(-MAX_CONTEXT_BYTES);
      // Start on a complete UTF-8 character when trimming the oldest context.
      let start = 0;
      while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
      return sealAesGcm(bytes.subarray(start), key, Buffer.from(grant)).toString("base64url");
    },

    open(token: string | undefined, grant: string) {
      if (!token || token.length > MAX_TOKEN_LENGTH || !/^[\w-]+$/.test(token)) return "";
      const bytes = Buffer.from(token, "base64url");
      if (
        bytes.length <= AES_GCM_OVERHEAD_BYTES ||
        bytes.length > AES_GCM_OVERHEAD_BYTES + MAX_CONTEXT_BYTES
      ) {
        return "";
      }
      return openAesGcm(bytes, key, Buffer.from(grant))?.toString("utf8") ?? "";
    },
  };
}
