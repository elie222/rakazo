import type { MessageBlock } from "@rakazo/contracts";
import { CALL_CLIENT_NONCE_PREFIX } from "./call-nonce.js";

/** Server settings shared by the API and worker. Calls require an explicit opt-in. */
export function phoneCallSettings(source: Record<string, string | undefined> = {}) {
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    phoneCallsEnabled: source.PHONE_CALLS_ENABLED === "true",
    phoneCallCooldownMinutes: positive(source.PHONE_CALL_COOLDOWN_MINUTES, 2),
    phoneCallRingSeconds: positive(source.PHONE_CALL_RING_SECONDS, 45),
  };
}

export type CallRequestBlock = Extract<MessageBlock, { kind: "call_request" }>;

/**
 * The call request's own nonce: it carries the call id like every message on
 * the call, so the transcript groups the request with the conversation, and it
 * is the idempotency key for the request.
 */
export function callRequestClientNonce(callId: string): string {
  if (callId.includes(":")) throw new Error(`callId must not contain ":": ${callId}`);
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:request`;
}

export function callRequestBlock(
  blocks: readonly MessageBlock[] | null | undefined,
): CallRequestBlock | undefined {
  const block = blocks?.[0];
  return block?.kind === "call_request" ? block : undefined;
}

/** The call still ringing among a chat's newest messages, if any. */
export function ringingCall(
  messages: ReadonlyArray<{ role: string; blocks: unknown }>,
  now = Date.now(),
): Pick<CallRequestBlock, "callId" | "reason" | "opening" | "expiresAt"> | null {
  for (const message of messages) {
    if (message.role !== "bot" || !Array.isArray(message.blocks)) continue;
    const block = callRequestBlock(message.blocks as MessageBlock[]);
    if (block?.status !== "ringing") continue;
    if (Date.parse(block.expiresAt) <= now) continue;
    return {
      callId: block.callId,
      reason: block.reason,
      opening: block.opening,
      expiresAt: block.expiresAt,
    };
  }
  return null;
}
