import type { MessagingInboundMessage, MessagingSendResult } from "@rakazo/adapter-kit";
import type { MessagingPlatform } from "./chat-sdk-surface.js";

export interface TeamChatEmulatorInbound {
  handle?: string;
  threadId?: string;
  isDirect?: boolean;
  from?: string;
  fromLabel?: string | null;
  channelName?: string | null;
  participants?: string[];
  content: string;
  mediaUrl?: string | null;
  workspaceId?: string;
  conversationKey?: string;
  kind?: MessagingInboundMessage["kind"];
  replyThreadId?: string | null;
  senderIsBot?: boolean;
  participantNames?: string[];
}

interface SentPost {
  threadId: string;
  body: string;
  handle: string;
}

/**
 * Deterministic team-chat helpers for CI: build inbound fixtures and record
 * outbound sends without a live Slack network.
 */
export class MessagingTeamChatEmulator {
  readonly provider = "teamchat-emulator";
  readonly sent: SentPost[] = [];
  private handleCounter = 0;
  private inboundCounter = 0;

  private nextHandle(prefix: string): string {
    this.handleCounter += 1;
    return `${prefix}-${this.handleCounter}`;
  }

  buildInbound(partial: TeamChatEmulatorInbound): MessagingInboundMessage {
    this.inboundCounter += 1;
    const isDirect = partial.isDirect ?? false;
    return {
      type: "message",
      provider: this.provider,
      handle: partial.handle ?? this.nextHandle("inbound"),
      threadId:
        partial.threadId ?? `${this.provider}:${isDirect ? "dm" : "room"}-${this.inboundCounter}`,
      isDirect,
      from: partial.from ?? "U-emulator",
      fromLabel: partial.fromLabel === undefined ? "Emulator User" : partial.fromLabel,
      channelName: isDirect ? null : (partial.channelName ?? "emulator-room"),
      participants: partial.participants ?? (isDirect ? [] : ["U-emulator", "U-peer"]),
      content: partial.content,
      mediaUrl: partial.mediaUrl ?? null,
      workspaceId: partial.workspaceId ?? "T-emulator",
      conversationKey: partial.conversationKey,
      kind: partial.kind,
      replyThreadId: partial.replyThreadId,
      senderIsBot: partial.senderIsBot,
      participantNames: partial.participantNames,
    };
  }

  /** Platform descriptor for mounting beside other messaging platforms in tests. */
  createPlatform(): MessagingPlatform {
    return {
      provider: this.provider,
      capabilities: { direct: true, groups: true, typing: false },
      // The adapter is only consulted for outbound post / openDM in unit tests that
      // drive ChatSdkMessagingSurface; prefer createRecordingMessagingSurface for
      // focused send recording without Chat SDK wiring.
      adapter: {
        version: "1.0.0",
        botUsername: "rakazo-emulator",
        postMessage: async (threadId: string, message: { text?: string }) => {
          const handle = this.allocateHandle("outbound");
          this.sent.push({ threadId, body: message.text ?? "", handle });
          return { id: handle, html_url: null };
        },
      } as unknown as MessagingPlatform["adapter"],
      directThreadId: (address) => `${this.provider}:dm:${address}`,
    };
  }

  /** Public handle allocator for test helpers that record outbound sends. */
  allocateHandle(prefix: string): string {
    this.handleCounter += 1;
    return `${prefix}-${this.handleCounter}`;
  }
}

/** Thin MessagingSurface stand-in that only records sendToThread for unit tests. */
export function createRecordingMessagingSurface(emulator: MessagingTeamChatEmulator): {
  sendToThread: (request: { threadId: string; body: string }) => Promise<MessagingSendResult>;
  sent: SentPost[];
} {
  return {
    sent: emulator.sent,
    async sendToThread(request) {
      const handle = emulator.allocateHandle("recorded");
      emulator.sent.push({ threadId: request.threadId, body: request.body, handle });
      return { handle };
    },
  };
}
