import type { MessagingOutboundStatus } from "@rakazo/adapter-kit";
import type { SendblueAdapterConfig, SendblueThreadId } from "chat-adapter-sendblue";
import { lazyChatAdapter } from "../../../messaging/lazy-chat-adapter.js";
import {
  asRecord,
  defineMessagingPlatform,
  MESSAGING_SEND_TIMEOUT_MS,
  stringField,
} from "../../../messaging/messaging-platform-descriptor.js";

export const sendblueMessaging = defineMessagingPlatform({
  env: {
    sendblueApiKeyId: { name: "SENDBLUE_API_KEY_ID", required: true },
    sendblueApiSecret: { name: "SENDBLUE_API_SECRET", required: true },
    sendblueSigningSecret: { name: "SENDBLUE_SIGNING_SECRET", required: true },
    sendbluePhoneNumber: { name: "SENDBLUE_PHONE_NUMBER", required: true },
  },
  mount(env, options) {
    const lineNumber = env.sendbluePhoneNumber;
    const config: Partial<SendblueAdapterConfig> = {
      apiKey: env.sendblueApiKeyId,
      apiSecret: env.sendblueApiSecret,
      defaultFromNumber: lineNumber,
      webhookSecret: env.sendblueSigningSecret,
      allowedServices: ["iMessage", "SMS", "RCS"],
      // Delivery-status callbacks need a public HTTPS origin; local setups skip them.
      ...(options.apiUrl?.startsWith("https://")
        ? { statusCallbackUrl: new URL("/api/v1/messaging/webhook/sendblue", options.apiUrl).href }
        : {}),
    };
    // chat@4.39 derives thread.isDM solely from the optional Adapter.isDM
    // hook, and chat-adapter-sendblue@0.2.0 omits it — without this every
    // 1:1 message would route as a group. Derive it from the thread id.
    const isDM = (threadId: string) => !decodeSendblueThreadId(threadId).groupId;
    const adapter = lazyChatAdapter(
      "sendblue",
      async () => {
        const { createSendblueAdapter } = await import("chat-adapter-sendblue");
        const sendblue = createSendblueAdapter(config);
        // The SDK's own retries (twice, no idempotency key) would duplicate
        // texts and stall the outbox drain; the outbox owns retries instead.
        Object.assign(sendblue, {
          isDM,
          sdk: sendblue.getSdk().withOptions({
            maxRetries: 0,
            timeout: MESSAGING_SEND_TIMEOUT_MS,
            ...options.sendblueTransport,
          }),
        });
        return sendblue;
      },
      { encodeThreadId: encodeSendblueThreadId, decodeThreadId: decodeSendblueThreadId, isDM },
    );
    return {
      provider: "sendblue",
      capabilities: { direct: true, groups: true, receipt: "typing" },
      adapter,
      address: lineNumber,
      directThreadId: (address) =>
        encodeSendblueThreadId({ fromNumber: lineNumber, contactNumber: address }),
      peekStatuses: parseSendblueStatuses,
      participants: (raw) => sendblueParticipants(raw, lineNumber),
      rosterAt: (raw) => sendblueRosterAt(raw),
      channelName: (raw) => sendblueGroupName(raw),
      transport: (raw) => sendblueTransport(raw),
    };
  },
});

/** chat-adapter-sendblue's thread ids, available before its module loads. */
function encodeSendblueThreadId({ fromNumber, contactNumber, groupId }: SendblueThreadId): string {
  const from = Buffer.from(fromNumber).toString("base64url");
  if (groupId) return `sendblue:${from}:g:${Buffer.from(groupId).toString("base64url")}`;
  return `sendblue:${from}:${Buffer.from(contactNumber ?? "").toString("base64url")}`;
}

function decodeSendblueThreadId(threadId: string): SendblueThreadId {
  const [prefix, from, rest, group] = threadId.split(":");
  if (prefix !== "sendblue" || from === undefined || rest === undefined) {
    throw new Error(`Invalid Sendblue thread ID: ${threadId}`);
  }
  const fromNumber = Buffer.from(from, "base64url").toString();
  return rest === "g" && group
    ? { fromNumber, groupId: Buffer.from(group, "base64url").toString() }
    : { fromNumber, contactNumber: Buffer.from(rest, "base64url").toString() };
}

/** Sendblue reports outbound delivery as webhooks the Chat SDK ignores. */
export function parseSendblueStatuses(payload: unknown): MessagingOutboundStatus[] {
  const body = asRecord(payload);
  const handle = body && stringField(body, "message_handle");
  if (body?.is_outbound !== true || !handle) return [];
  return [
    { type: "status", provider: "sendblue", handle, status: stringField(body, "status") ?? "" },
  ];
}

function sendblueParticipants(raw: unknown, lineNumber: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const participants = (raw as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return [];
  return participants.filter(
    (entry): entry is string => typeof entry === "string" && entry !== lineNumber,
  );
}

/** When Sendblue says the roster was current: the message's send time. */
function sendblueRosterAt(raw: unknown): Date | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sent = (raw as { date_sent?: unknown }).date_sent;
  if (typeof sent !== "string") return null;
  const at = new Date(sent);
  return Number.isNaN(at.getTime()) ? null : at;
}

function sendblueGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as { group_display_name?: unknown }).group_display_name;
  return typeof name === "string" && name ? name : null;
}

function sendblueTransport(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const service = (raw as { service?: unknown }).service;
  return service === "iMessage" || service === "SMS" || service === "RCS" ? service : null;
}
