import type { AttachmentTransport } from "@chat-adapter/shared";
import { downloadAttachment, NetworkError } from "@chat-adapter/shared";
import { WhatsAppAdapter, WhatsAppApiError } from "@chat-adapter/whatsapp";
import type { MessagingOutbound, MessagingOutboundStatus } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, uploadSizeFromEnv } from "@rakazo/core";
import type { Attachment } from "chat";
import { ConsoleLogger, convertEmojiPlaceholders } from "chat";
import { splitMarkdown } from "../../../messaging/markdown-split.js";
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
    whatsappApiUrl: { name: "WHATSAPP_API_URL" },
    whatsappBotUsername: { name: "WHATSAPP_BOT_USERNAME" },
    /** Inbound files download up to the deployment's upload limit (MAX_UPLOAD_SIZE_MB). */
    whatsappMediaMaxBytes: { read: uploadSizeFromEnv },
  },
  mount(env) {
    // The defaults createWhatsAppAdapter applies, which the subclass does not get for free.
    const adapter = new WhatsAppGraph({
      accessToken: env.whatsappAccessToken,
      apiUrl: env.whatsappApiUrl,
      appSecret: env.whatsappAppSecret,
      logger: new ConsoleLogger("info").child("whatsapp"),
      // Values built by hand rather than read from the environment may leave it out.
      mediaMaxBytes: env.whatsappMediaMaxBytes ?? ATTACHMENT_MAX_BYTES,
      phoneNumberId: env.whatsappPhoneNumberId,
      userName: env.whatsappBotUsername ?? "whatsapp-bot",
      verifyToken: env.whatsappVerifyToken,
    });
    return {
      provider: "whatsapp",
      outbound: whatsappOutbound,
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

/** WhatsApp's media hosts, which the adapter lets its token reach but does not export. */
const WHATSAPP_MEDIA_HOSTS = ["fbcdn.net", "fbsbx.com"];

/**
 * Time one inbound file download may take: the intake's own time for one try at a direct-message
 * file, which starts its next try only once the last has settled. The SDK's 30 seconds is too
 * short for a file at the upload limit.
 */
const WHATSAPP_MEDIA_TIMEOUT_MS = 10 * 60_000;

/** Time the media lookup before a download may take, so a stalled one frees its download slot. */
const WHATSAPP_MEDIA_LOOKUP_MS = 30_000;

const UNTRUSTED_MEDIA_URL = "Refusing to send the access token to an untrusted media URL";

/**
 * The adapter, plus the media lookup that needs its protected Graph API base and token, and its
 * media download held to the deployment's upload limit instead of the SDK's 25 MiB.
 */
class WhatsAppGraph extends WhatsAppAdapter {
  private readonly mediaMaxBytes: number;

  constructor({
    mediaMaxBytes,
    ...config
  }: ConstructorParameters<typeof WhatsAppAdapter>[0] & { mediaMaxBytes: number }) {
    super(config);
    this.mediaMaxBytes = mediaMaxBytes;
  }

  /**
   * The size WhatsApp reports for an inbound file, from the media lookup that also comes before
   * its download: the webhook does not carry it, and the adapter does not keep it.
   */
  async mediaSize(attachment: Attachment, signal: AbortSignal): Promise<number | undefined> {
    const mediaId = attachment.fetchMetadata?.mediaId;
    if (!mediaId) return undefined;
    const reported = (await this.lookUpMedia(mediaId, signal))?.file_size;
    const size =
      typeof reported === "number"
        ? reported
        : typeof reported === "string"
          ? Number(reported)
          : NaN;
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  }

  /** The adapter's download, held to the upload limit, with the time a file that size needs. */
  override async downloadMedia(mediaId: string, transport?: AttachmentTransport): Promise<Buffer> {
    try {
      const url = (await this.lookUpMedia(mediaId, deadlineSignal(WHATSAPP_MEDIA_LOOKUP_MS)))?.url;
      if (typeof url !== "string" || !this.isMediaUrl(url)) {
        throw new NetworkError("whatsapp", UNTRUSTED_MEDIA_URL);
      }
      return await downloadAttachment(url, {
        adapter: "whatsapp",
        headers: (target) => {
          if (!this.isMediaUrl(target.href))
            throw new NetworkError("whatsapp", UNTRUSTED_MEDIA_URL);
          return { authorization: `Bearer ${this.accessToken}` };
        },
        hosts: [...WHATSAPP_MEDIA_HOSTS, new URL(this.graphApiUrl).hostname],
        limit: this.mediaMaxBytes,
        timeoutMs: WHATSAPP_MEDIA_TIMEOUT_MS,
        transport,
      });
    } catch (error) {
      this.logger.error("Failed to download media", { mediaId });
      if (error instanceof NetworkError || error instanceof WhatsAppApiError) throw error;
      throw new NetworkError(
        "whatsapp",
        `Failed to download media ${mediaId}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async lookUpMedia(mediaId: string, signal?: AbortSignal) {
    const response = await fetch(`${this.graphApiUrl}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new WhatsAppApiError(
        "WhatsApp media lookup failed",
        response.status,
        await response.text(),
      );
    }
    return asRecord(await response.json());
  }

  /** The adapter's rule: the Graph API's own origin, or a WhatsApp media host over HTTPS. */
  private isMediaUrl(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    if (url.origin === new URL(this.graphApiUrl).origin) return true;
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      WHATSAPP_MEDIA_HOSTS.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
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
 * WhatsApp renders Markdown as its own formatting, and splits at the 4,096-character limit.
 */
export const whatsappOutbound: MessagingOutbound = {
  markdown: true,
  split: (body) => splitMarkdown(body, { limit: 4096, sent: whatsappPayloads }),
};

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
