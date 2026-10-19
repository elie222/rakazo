import type { Adapter } from "chat";
import { SendblueAdapter } from "chat-adapter-sendblue";
import SendblueAPI from "sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { parseSendblueStatus } from "./messaging-platforms.js";

interface SentMessage {
  kind: "dm" | "group";
  to?: string;
  groupId?: string;
  body: string;
  handle: string;
}

export interface EmulatorInboundInput {
  fromNumber: string;
  content: string;
  groupId?: string;
  groupName?: string;
  participants?: string[];
  handle?: string;
  mediaUrl?: string;
}

/**
 * Deterministic Sendblue boundary emulator: serves the vendor API over an
 * injected fetch, records outbound sends, and builds signed inbound webhook
 * requests for end-to-end journeys.
 */
export class SendBlueEmulator {
  readonly signingSecret = "test-signing-secret";
  readonly phoneNumber = "+15550009999";
  readonly sent: SentMessage[] = [];
  readonly typingIndicators: string[] = [];
  private handleCounter = 0;
  private failRemaining = 0;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "api.sendblue.com") {
      throw new Error(`SendBlue emulator received unexpected URL ${url}`);
    }
    const method = init?.method?.toUpperCase() ?? "GET";
    if (
      (url.pathname === "/api/send-message" || url.pathname === "/api/send-group-message") &&
      method === "POST" &&
      this.failRemaining > 0
    ) {
      this.failRemaining -= 1;
      return Response.json({ status: "ERROR", message: "emulated failure" }, { status: 500 });
    }
    if (url.pathname === "/api/send-message" && method === "POST") {
      const body = parseBody(init?.body);
      const handle = this.nextHandle();
      this.sent.push({
        kind: "dm",
        to: String(body.number ?? ""),
        body: String(body.content ?? ""),
        handle,
      });
      return Response.json({ message_handle: handle, status: "QUEUED" });
    }
    if (url.pathname === "/api/send-typing-indicator" && method === "POST") {
      const body = parseBody(init?.body);
      if (typeof body.number !== "string" || !body.number) {
        return Response.json({ status: "ERROR", message: "number is required" }, { status: 400 });
      }
      this.typingIndicators.push(body.number);
      return Response.json({ status: "SENT" });
    }
    if (url.pathname === "/api/send-group-message" && method === "POST") {
      const body = parseBody(init?.body);
      const handle = this.nextHandle();
      this.sent.push({
        kind: "group",
        groupId: String(body.group_id ?? ""),
        body: String(body.content ?? ""),
        handle,
      });
      return Response.json({ message_handle: handle, status: "QUEUED" });
    }
    if (url.pathname === "/api/mark-read" && method === "POST") {
      // Best-effort read receipts from the chat adapter; nothing to record.
      return Response.json({ status: "OK" });
    }
    throw new Error(`SendBlue emulator received unexpected request ${method} ${url.pathname}`);
  };

  private nextHandle(): string {
    this.handleCounter += 1;
    return `emulated-handle-${this.handleCounter}`;
  }

  /** Next N send-message / send-group-message calls fail with HTTP 500. */
  failNextSends(count: number): void {
    this.failRemaining = count;
  }

  /** A webhook request exactly as Sendblue would deliver it (static secret header). */
  buildInboundRequest(input: EmulatorInboundInput): Request {
    return new Request("https://rakazo.test/api/v1/messaging/webhook/sendblue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": this.signingSecret,
      },
      body: JSON.stringify({
        content: input.content,
        is_outbound: false,
        status: "RECEIVED",
        service: "iMessage",
        message_handle: input.handle ?? this.nextHandle(),
        from_number: input.fromNumber,
        to_number: this.phoneNumber,
        number: input.fromNumber,
        sendblue_number: this.phoneNumber,
        media_url: input.mediaUrl ?? "",
        group_id: input.groupId ?? "",
        participants: input.participants ?? [input.fromNumber, this.phoneNumber],
        group_display_name: input.groupName ?? null,
        date_sent: "2026-01-01T00:00:00.000Z",
      }),
    });
  }

  /** Outbound delivery-status webhook (same auth header as inbound). */
  buildStatusRequest(input: { handle: string; status: string }): Request {
    return new Request("https://rakazo.test/api/v1/messaging/webhook/sendblue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": this.signingSecret,
      },
      body: JSON.stringify({
        content: "",
        is_outbound: true,
        status: input.status,
        service: "iMessage",
        message_handle: input.handle,
        from_number: this.phoneNumber,
        to_number: "+15550001111",
        sendblue_number: this.phoneNumber,
        media_url: "",
        group_id: "",
        participants: [],
        group_display_name: null,
        date_sent: "2026-01-01T00:00:00.000Z",
      }),
    });
  }
}

/**
 * The production sendblue platform wired to the emulator: the real Chat SDK
 * adapter and official Sendblue SDK, with only the HTTP boundary swapped.
 */
export function createEmulatedSendbluePlatform(emulator: SendBlueEmulator): MessagingPlatform {
  const adapter = new SendblueAdapter({
    apiKey: "emulated-key",
    apiSecret: "emulated-secret",
    defaultFromNumber: emulator.phoneNumber,
    webhookSecret: emulator.signingSecret,
    allowedServices: ["iMessage", "SMS", "RCS"],
  });
  const sdk = new SendblueAPI({
    apiKey: "emulated-key",
    apiSecret: "emulated-secret",
    baseURL: "https://api.sendblue.com",
    fetch: emulator.fetch,
  });
  // The adapter builds its own SDK client without fetch injection; swap it
  // for one that speaks to the emulator instead of the live vendor. Also
  // supply the Adapter.isDM hook chat-adapter-sendblue@0.2.0 omits (chat@4.39
  // derives thread.isDM solely from it), mirroring messagingPlatformsFromEnv.
  Object.assign(adapter as unknown as Record<string, unknown>, { sdk });
  Object.assign(adapter, {
    isDM: (threadId: string) => !adapter.decodeThreadId(threadId).groupId,
  } satisfies Pick<Adapter, "isDM">);
  return {
    provider: "sendblue",
    capabilities: { direct: true, groups: true, typing: true },
    adapter,
    directThreadId: (address) =>
      adapter.encodeThreadId({ fromNumber: emulator.phoneNumber, contactNumber: address }),
    peekStatus: (payload) => parseSendblueStatus(payload),
    participants: (raw) => {
      const participants = (raw as { participants?: unknown }).participants;
      return Array.isArray(participants)
        ? participants.filter(
            (entry): entry is string => typeof entry === "string" && entry !== emulator.phoneNumber,
          )
        : [];
    },
    channelName: (raw) => {
      const name = (raw as { group_display_name?: unknown }).group_display_name;
      return typeof name === "string" && name ? name : null;
    },
  };
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string" || !body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
