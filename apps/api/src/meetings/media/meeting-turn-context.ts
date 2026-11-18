import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const MAX_CONTEXT_BYTES = 1_600;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_LENGTH = Math.ceil(((MAX_CONTEXT_BYTES + NONCE_BYTES + TAG_BYTES) * 4) / 3);

/**
 * The transient camera page carries a sealed, size-limited window of the conversation.
 * Any API replica can resume it. It stays out of storage and expires with the media grant.
 */
export function meetingTurnContext(signingSecret: string) {
  const key = createHmac("sha256", signingSecret).update("meeting-media/context/v1").digest();

  return {
    seal(text: string, grant: string) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(grant));
      const bytes = Buffer.from(text).subarray(-MAX_CONTEXT_BYTES);
      // Start on a complete UTF-8 character when trimming the oldest context.
      let start = 0;
      while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
      const encrypted = Buffer.concat([cipher.update(bytes.subarray(start)), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    },

    open(token: string | undefined, grant: string) {
      if (!token || token.length > MAX_TOKEN_LENGTH || !/^[\w-]+$/.test(token)) return "";
      const bytes = Buffer.from(token, "base64url");
      const payloadOffset = NONCE_BYTES + TAG_BYTES;
      if (bytes.length <= payloadOffset || bytes.length > payloadOffset + MAX_CONTEXT_BYTES) {
        return "";
      }
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(grant));
      decipher.setAuthTag(bytes.subarray(NONCE_BYTES, payloadOffset));
      try {
        return Buffer.concat([
          decipher.update(bytes.subarray(payloadOffset)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // A changed token or a token carried from another media grant fails authentication.
        return "";
      }
    },
  };
}
