import { createHmac } from "node:crypto";
import type { MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "../../../messaging/chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "../../../messaging/messaging-platforms.js";

// Fake credentials and a stubbed fetch: the real Photon adapter verifies and
// routes webhooks offline; nothing here reaches Spectrum Cloud.
const webhookSecret = "whsec_test";

function createSurface() {
  const platforms = messagingPlatformsFromEnv(
    {
      photonProjectId: "project-test",
      photonProjectSecret: "secret-test",
      photonWebhookSecret: webhookSecret,
    },
    { pollInboundMessages: true },
  );
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events };
}

function delivery(direction = "inbound", chatGuid = "any;-;+15550001111") {
  return {
    event: "messages",
    space: { id: chatGuid },
    message: {
      id: "msg-test",
      direction,
      sender: { id: "+15550001111" },
      content: { type: "text", text: "hello bot" },
      timestamp: new Date().toISOString(),
    },
  };
}

function webhook(payload: unknown, secret = webhookSecret, ageSeconds = 0) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://example.test/api/v1/messaging/webhook/photon", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-event": "messages",
      "x-spectrum-timestamp": timestamp,
      "x-spectrum-signature": signature,
    },
    body,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      // Spectrum Cloud's REST envelope; a shared-line token keeps the gRPC
      // client unconnected until something streams or sends.
      const url = String(input instanceof Request ? input.url : input);
      const data = url.endsWith("/imessage/tokens")
        ? { type: "shared", token: "token-test", expiresIn: 3600 }
        : {};
      return Response.json({ succeed: true, data });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Photon messaging conformance", () => {
  it("preserves a dedicated line in the reply thread", async () => {
    const { surface, events } = createSurface();
    const payload = delivery();
    await surface.handleWebhook(
      "photon",
      webhook({
        ...payload,
        space: { ...payload.space, phone: "+15550002222" },
      }),
    );
    expect(events[0]).toMatchObject({ threadId: "photon:any;-;+15550001111~+15550002222" });
    await surface.shutdown();
  });

  it.each(["image/jpeg", "audio/mp4"])(
    "does not claim retrievable %s media from metadata alone",
    async (mimeType) => {
      const { surface, events } = createSurface();
      const payload = delivery();
      await surface.handleWebhook(
        "photon",
        webhook({
          ...payload,
          message: {
            ...payload.message,
            content: {
              type: "attachment",
              id: "file-test",
              name: "example",
              mimeType,
              size: 100,
            },
          },
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ content: "", mediaUrl: null });
      expect(events[0]).not.toHaveProperty("attachments");
      await surface.shutdown();
    },
  );

  it("rejects stale signed deliveries", async () => {
    const { surface, events } = createSurface();
    expect(
      (await surface.handleWebhook("photon", webhook(delivery(), webhookSecret, 600)))?.status,
    ).toBe(400);
    expect(events).toEqual([]);
    await surface.shutdown();
  });

  it("does not route groups even on a project with group access", async () => {
    const { surface, events } = createSurface();
    expect(
      (await surface.handleWebhook("photon", webhook(delivery("inbound", "any;+;group-test"))))
        ?.status,
    ).toBe(200);
    expect(events).toEqual([]);
    await surface.shutdown();
  });

  it("retries a failed sink and deduplicates a successful redelivery", async () => {
    const { surface } = createSurface();
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue(undefined);
    surface.onInbound(sink);
    expect((await surface.handleWebhook("photon", webhook(delivery())))?.status).toBe(500);
    expect((await surface.handleWebhook("photon", webhook(delivery())))?.status).toBe(200);
    expect((await surface.handleWebhook("photon", webhook(delivery())))?.status).toBe(200);
    expect(sink).toHaveBeenCalledTimes(2);
    await surface.shutdown();
  });

  it("isolates named projects with separate signing secrets and thread namespaces", async () => {
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        photonProjects: [
          {
            name: "first",
            projectId: "project-first",
            projectSecret: "fake-first",
            webhookSecret: "hook-first",
          },
          {
            name: "second",
            projectId: "project-second",
            projectSecret: "fake-second",
            webhookSecret: "hook-second",
          },
        ],
      }),
    );
    const sink = vi.fn(async (_event: MessagingInboundEvent) => {});
    surface.onInbound(sink);
    expect(
      (await surface.handleWebhook("photon-second", webhook(delivery(), "hook-first")))?.status,
    ).toBe(401);
    expect(sink).not.toHaveBeenCalled();
    for (const name of ["first", "second"]) {
      expect(
        (await surface.handleWebhook(`photon-${name}`, webhook(delivery(), `hook-${name}`)))
          ?.status,
      ).toBe(200);
    }
    expect(sink.mock.calls.map(([event]) => event)).toMatchObject([
      { provider: "photon-first", threadId: "photon-first:any;-;+15550001111" },
      { provider: "photon-second", threadId: "photon-second:any;-;+15550001111" },
    ]);
    await surface.shutdown();
  });

  it("delivers a signed direct message under the photon provider", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery()));
    expect(response?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "photon",
      threadId: "photon:any;-;+15550001111",
      isDirect: true,
      handle: "msg-test",
      from: "+15550001111",
      content: "hello bot",
    });
    await surface.shutdown();
  });

  it("ignores echoes of the line's own outbound messages", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery("outbound")));
    expect(response?.status).toBe(200);
    expect(events).toEqual([]);
    await surface.shutdown();
  });

  it("rejects a webhook signed with another secret", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("photon", webhook(delivery(), "whsec_forged"));
    expect(response?.status).toBe(401);
    expect(events).toEqual([]);
    await surface.shutdown();
  });
});
