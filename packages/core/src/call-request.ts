import type { MessageBlock } from "@rakazo/contracts";
import { CALL_CLIENT_NONCE_PREFIX } from "./call-nonce.js";

/** How long the bot's call rings before it counts as missed. */
export const CALL_REQUEST_RING_MS = 45_000;
/** Bots share this cooldown across every chat owned by the recipient. */
export const CALL_REQUEST_COOLDOWN_MS = 10 * 60_000;

export type CallRequestBlock = Extract<MessageBlock, { kind: "call_request" }>;

export type IncomingCall = {
  callId: string;
  reason: string;
  opening: string;
  expiresAt: string;
};

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
): IncomingCall | null {
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
