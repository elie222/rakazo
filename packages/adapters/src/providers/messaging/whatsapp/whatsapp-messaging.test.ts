import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { AttachmentTransport } from "@chat-adapter/shared";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "../../../messaging/chat-sdk-surface.js";
import {
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
} from "../../../messaging/messaging-platforms.js";
import { whatsappMessaging } from "./whatsapp-messaging.js";

const appSecret = "fake-app-secret";
const surfaces: ChatSdkMessagingSurface[] = [];

function surface() {
  const messaging = new ChatSdkMessagingSurface([
    whatsappMessaging.mount(
      {
        whatsappAccessToken: "fake-access-token",
        whatsappPhoneNumberId: "123",
        whatsappAppSecret: appSecret,
        whatsappVerifyToken: "fake-verify-token",
        whatsappApiUrl: undefined,
        whatsappBotUsername: undefined,
        whatsappMediaMaxBytes: ATTACHMENT_MAX_BYTES,
      },
      {},
    ),
  ]);
  surfaces.push(messaging);
  return messaging;
}

function post(value: unknown, secret: string | null = appSecret) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "fake-account", changes: [{ field: "messages", value }] }],
  });
  return new Request("https://api.example.test/api/v1/messaging/webhook/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null
        ? {}
        : {
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          }),
    },
    body,
  });
}

afterEach(async () => {
  await Promise.all(surfaces.splice(0).map((messaging) => messaging.shutdown()));
  vi.unstubAllGlobals();
});

describe("direct WhatsApp webhook launch boundary", () => {
  it.each([
    ["fake-verify-token", 200],
    ["wrong-token", 403],
  ])("verifies the operator's callback token (%s)", async (token, status) => {
    const response = await surface().handleWebhook(
      "whatsapp",
      new Request(
        `https://api.example.test/api/v1/messaging/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`,
      ),
    );
    expect(response?.status).toBe(status);
    if (status === 200) expect(await response?.text()).toBe("12345");
  });

  it.each([null, "wrong-secret"])(
    "rejects unsigned or forged delivery callbacks (%s)",
    async (secret) => {
      const messaging = surface();
      const sink = vi.fn();
      messaging.onInbound(sink);
      const response = await messaging.handleWebhook(
        "whatsapp",
        post({ statuses: [{ id: "wamid.fake", status: "delivered" }] }, secret),
      );
      expect(response?.status).toBe(401);
      expect(sink).not.toHaveBeenCalled();
    },
  );

  it("forwards an authenticated asynchronous window rejection as failed", async () => {
    const messaging = surface();
    const sink = vi.fn();
    messaging.onInbound(sink);
    const response = await messaging.handleWebhook(
      "whatsapp",
      post({ statuses: [{ id: "wamid.fake", status: "failed", errors: [{ code: 131047 }] }] }),
    );
    expect(response?.status).toBe(200);
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      type: "status",
      provider: "whatsapp",
      handle: "wamid.fake",
      status: "FAILED",
    });
  });

  it("receives a signed direct message without making a network request", async () => {
    const network = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", network);
    const messaging = surface();
    const sink = vi.fn();
    messaging.onInbound(sink);
    const response = await messaging.handleWebhook(
      "whatsapp",
      post({
        messaging_product: "whatsapp",
        metadata: { phone_number_id: "123", display_phone_number: "15550009999" },
        contacts: [{ wa_id: "15550000001", profile: { name: "Example" } }],
        messages: [
          {
            from: "15550000001",
            id: "wamid.inbound",
            timestamp: "1700000000",
            type: "text",
            text: { body: "LINK-EXAMPLE" },
          },
        ],
      }),
    );
    expect(response?.status).toBe(200);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        provider: "whatsapp",
        threadId: "whatsapp:123:15550000001",
        isDirect: true,
        from: "15550000001",
        content: "LINK-EXAMPLE",
      }),
    );
    expect(network).not.toHaveBeenCalled();
  });
});

const MiB = 1024 * 1024;
const mediaUrl = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-1";

interface MediaDownloader {
  downloadMedia(mediaId: string, transport?: AttachmentTransport): Promise<Buffer>;
}

/**
 * The mounted adapter, from the same environment a deployment reads. It answers with the size
 * of what it downloaded: a failed assertion would print a whole buffer.
 */
function downloader(source: Record<string, string | undefined> = {}) {
  const [platform] = messagingPlatformsFromEnv(
    messagingEnvFromProcess({
      WHATSAPP_ACCESS_TOKEN: "fake-access-token",
      WHATSAPP_PHONE_NUMBER_ID: "123",
      WHATSAPP_APP_SECRET: appSecret,
      WHATSAPP_VERIFY_TOKEN: "fake-verify-token",
      ...source,
    }),
  );
  expect(platform?.provider).toBe("whatsapp");
  const adapter = platform!.adapter as unknown as MediaDownloader;
  return {
    downloadMedia: async (mediaId: string, transport: AttachmentTransport) =>
      (await adapter.downloadMedia(mediaId, transport)).byteLength,
  };
}

/** Meta's media lookup, answering with where the file is. */
function lookup(url: string | null = mediaUrl) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ url, id: "media-1" }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function body(bytes: number, options: { status?: number; headers?: Record<string, string> } = {}) {
  const content = Buffer.alloc(bytes, 7);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += MiB) {
    chunks.push(content.subarray(offset, offset + MiB));
  }
  return Object.assign(Readable.from(chunks), {
    statusCode: options.status ?? 200,
    statusMessage: "",
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

function serves(bytes: number, declared = true) {
  return vi.fn<AttachmentTransport>(async () =>
    body(bytes, declared ? { headers: { "content-length": String(bytes) } } : {}),
  );
}

describe("WhatsApp inbound file downloads", () => {
  it("downloads a file past the SDK's 25 MiB, up to the upload limit", async () => {
    const graph = lookup();
    const transport = serves(30 * MiB);
    const size = await downloader({ MAX_UPLOAD_SIZE_MB: "100" }).downloadMedia(
      "media-1",
      transport,
    );
    expect(size).toBe(30 * MiB);
    const [lookupUrl, init] = graph.mock.calls[0]!;
    expect(lookupUrl).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/media-1$/);
    expect(init?.headers).toEqual({ authorization: "Bearer fake-access-token" });
    const [url, , headers] = transport.mock.calls[0]!;
    expect(url.href).toBe(mediaUrl);
    expect(headers).toMatchObject({ authorization: "Bearer fake-access-token" });
  });

  it.each([true, false])(
    "refuses a file over the upload limit (declared: %s)",
    async (declared) => {
      lookup();
      await expect(
        downloader({ MAX_UPLOAD_SIZE_MB: "1" }).downloadMedia("media-1", serves(MiB + 1, declared)),
      ).rejects.toThrow("Attachment exceeds the download limit");
    },
  );

  it("holds files to the default upload limit when none is set", async () => {
    lookup();
    const whatsapp = downloader();
    await expect(whatsapp.downloadMedia("media-1", serves(ATTACHMENT_MAX_BYTES))).resolves.toBe(
      ATTACHMENT_MAX_BYTES,
    );
    await expect(
      whatsapp.downloadMedia("media-1", serves(ATTACHMENT_MAX_BYTES + 1, false)),
    ).rejects.toThrow("Attachment exceeds the download limit");
  });

  it.each([
    "https://media.example.test/m",
    "https://fbsbx.com.example.test/m",
    "http://lookaside.fbsbx.com/m",
    "https://lookaside.fbsbx.com:8443/m",
    null,
  ])("never sends the token to a media URL off WhatsApp's hosts (%s)", async (url) => {
    lookup(url);
    const transport = serves(1);
    await expect(downloader().downloadMedia("media-1", transport)).rejects.toThrow("untrusted");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["https://media.example.test/next", "https://lookaside.fbsbx.com:8443/next"])(
    "never follows a redirect off WhatsApp's hosts with the token (%s)",
    async (location) => {
      lookup();
      const transport = vi.fn<AttachmentTransport>(async () =>
        body(0, { status: 302, headers: { location } }),
      );
      await expect(downloader().downloadMedia("media-1", transport)).rejects.toThrow("untrusted");
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it("fails the way the adapter does when the lookup or the download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    await expect(downloader().downloadMedia("media-1", serves(1))).rejects.toMatchObject({
      name: "WhatsAppApiError",
      status: 404,
    });

    lookup();
    const transport = vi.fn<AttachmentTransport>(async () => {
      throw new Error("socket hang up");
    });
    await expect(downloader().downloadMedia("media-1", transport)).rejects.toMatchObject({
      name: "NetworkError",
      message: "Failed to download media media-1",
    });
  });
});
