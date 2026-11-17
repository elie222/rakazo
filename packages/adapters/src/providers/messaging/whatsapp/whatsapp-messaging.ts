import { WhatsAppAdapter, WhatsAppApiError } from "@chat-adapter/whatsapp";
import type { MessagingOutboundStatus } from "@rakazo/adapter-kit";
import type { Attachment } from "chat";
import { ConsoleLogger, convertEmojiPlaceholders } from "chat";
import {
  arrayField,
  asRecord,
  defineMessagingPlatform,
  stringField,
} from "../../../messaging/messaging-platform-descriptor.js";

export const whatsappMessaging = defineMessagingPlatform({
  env: {
    whatsappAccessToken: { name: "WHATSAPP_ACCESS_TOKEN", required: true },
    whatsappPhoneNumberId: { name: "WHATSAPP_PHONE_NUMBER_ID", required: true },
    whatsappAppSecret: { name: "WHATSAPP_APP_SECRET", required: true },
    whatsappVerifyToken: { name: "WHATSAPP_VERIFY_TOKEN", required: true },
  },
  mount(env) {
    // The same defaults createWhatsAppAdapter applies, which the subclass does not get for free.
    const adapter = new WhatsAppGraph({
      accessToken: env.whatsappAccessToken,
      apiUrl: process.env.WHATSAPP_API_URL,
      appSecret: env.whatsappAppSecret,
      logger: new ConsoleLogger("info").child("whatsapp"),
      phoneNumberId: env.whatsappPhoneNumberId,
      userName: process.env.WHATSAPP_BOT_USERNAME ?? "whatsapp-bot",
      verifyToken: env.whatsappVerifyToken,
    });
    return {
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, receipt: null, files: true },
      adapter,
      attachmentSize: (attachment, signal) => adapter.mediaSize(attachment, signal),
      peekStatuses: parseWhatsAppStatuses,
      isPermanentSendError: (error) =>
        (error instanceof WhatsAppApiError && error.errorCode === WHATSAPP_REENGAGEMENT_REQUIRED) ||
        isRejectedUpload(error),
    };
  },
});

/** The adapter, plus the media lookup that needs its protected Graph API base and token. */
class WhatsAppGraph extends WhatsAppAdapter {
  /**
   * The size WhatsApp reports for an inbound file, from the media lookup that also comes before
   * its download: the webhook does not carry it, and the adapter does not keep it.
   */
  async mediaSize(attachment: Attachment, signal: AbortSignal): Promise<number | undefined> {
    const mediaId = attachment.fetchMetadata?.mediaId;
    if (!mediaId) return undefined;
    const response = await fetch(`${this.graphApiUrl}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`WhatsApp media lookup failed with status ${response.status}`);
    }
    const reported = asRecord(await response.json())?.file_size;
    const size =
      typeof reported === "number"
        ? reported
        : typeof reported === "string"
          ? Number(reported)
          : NaN;
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  }
}

/** Meta 131047: outside the 24-hour window only a template can reach the user. */
const WHATSAPP_REENGAGEMENT_REQUIRED = 131047;

/**
 * The adapter refuses a file before uploading it when it is over WhatsApp's limit for its kind
 * (5 MB images, 16 MB audio and video) or empty; sending it again cannot succeed.
 */
function isRejectedUpload(error: unknown): boolean {
  return error instanceof Error && error.name === "ValidationError";
}

/** Exposes the adapter's Markdown rendering, which the package does not export. */
class WhatsAppRenderer extends WhatsAppAdapter {
  render(markdown: string): string {
    return convertEmojiPlaceholders(this.formatConverter.renderPostable({ markdown }), "whatsapp");
  }
}

let whatsappRenderer: WhatsAppRenderer | undefined;

/**
 * The text the adapter sends for a Markdown part. Past the limit it splits the rendered text
 * again, outside the queue's per-part retries and through any formatting.
 */
export function whatsappPayloads(markdown: string): string[] {
  whatsappRenderer ??= new WhatsAppRenderer({
    accessToken: "",
    appSecret: "",
    logger: new ConsoleLogger("silent"),
    phoneNumberId: "",
    userName: "",
    verifyToken: "",
  });
  return [whatsappRenderer.render(markdown)];
}

/**
 * WhatsApp reports asynchronous delivery (including 24-hour-window failures
 * such as 131047) only as `statuses[]` webhooks, which the Chat SDK skips.
 */
export function parseWhatsAppStatuses(payload: unknown): MessagingOutboundStatus[] {
  const statuses: MessagingOutboundStatus[] = [];
  for (const entry of arrayField(asRecord(payload), "entry")) {
    for (const change of arrayField(asRecord(entry), "changes")) {
      for (const item of arrayField(asRecord(asRecord(change)?.value), "statuses")) {
        const record = asRecord(item) ?? {};
        const handle = stringField(record, "id");
        const status = stringField(record, "status");
        if (!handle || !status) continue;
        statuses.push({
          type: "status",
          provider: "whatsapp",
          handle,
          status: status.toUpperCase(),
        });
      }
    }
  }
  return statuses;
}
