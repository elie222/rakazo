import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "../../../messaging/chat-sdk-surface.js";
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
