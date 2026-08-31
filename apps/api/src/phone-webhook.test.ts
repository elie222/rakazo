import { parseSendBlueInbound } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountPhoneWebhookRoutes, PHONE_WEBHOOK_PATH } from "./phone-webhook.js";

const SIGNING_SECRET = "phone-signing-secret-test-value";
const SIGNING_HEADER = "sb-signing-secret";

function mount(handle?: (event: unknown) => Promise<void>) {
  const handler = vi.fn(handle ?? (async () => undefined));
  const app = new Hono();
  mountPhoneWebhookRoutes(app, {
    signingSecret: SIGNING_SECRET,
    signingHeader: SIGNING_HEADER,
    parseInbound: parseSendBlueInbound,
    handle: handler,
  });
  return { app, handler };
}

function post(body: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

const receivePayload = JSON.stringify({
  content: "hi",
  is_outbound: false,
  status: "RECEIVED",
  message_handle: "handle-1",
  from_number: "+15551234567",
  sendblue_number: "+15550009999",
  media_url: "",
  group_id: "",
  participants: ["+15551234567", "+15550009999"],
  group_display_name: null,
});

describe("phone webhook HTTP route", () => {
  it("rejects missing and wrong signing secrets with a uniform 401", async () => {
    const { app, handler } = mount();
    const missing = await app.request(PHONE_WEBHOOK_PATH, post(receivePayload));
    const wrong = await app.request(
      PHONE_WEBHOOK_PATH,
      post(receivePayload, { [SIGNING_HEADER]: "wrong-secret" }),
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.text()).toBe(await wrong.text());
    expect(handler).not.toHaveBeenCalled();
  });

  it("caps bodies at 64KB", async () => {
    const { app, handler } = mount();
    const oversized = JSON.stringify({
      ...JSON.parse(receivePayload),
      content: "x".repeat(70 * 1024),
    });
    const res = await app.request(
      PHONE_WEBHOOK_PATH,
      post(oversized, { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches a parsed 1:1 message to the handler", async () => {
    const { app, handler } = mount();
    const res = await app.request(
      PHONE_WEBHOOK_PATH,
      post(receivePayload, { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      type: "message",
      handle: "handle-1",
      fromNumber: "+15551234567",
      groupId: null,
      groupName: null,
      participants: ["+15551234567", "+15550009999"],
      content: "hi",
      mediaUrl: null,
    });
  });

  it("dispatches group messages with their group id", async () => {
    const { app, handler } = mount();
    const groupPayload = JSON.stringify({
      ...JSON.parse(receivePayload),
      group_id: "grp-1",
      group_display_name: "Family",
    });
    const res = await app.request(
      PHONE_WEBHOOK_PATH,
      post(groupPayload, { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message", groupId: "grp-1", groupName: "Family" }),
    );
  });

  it("acknowledges outbound status events without calling the message handler", async () => {
    const { app, handler } = mount();
    const statusPayload = JSON.stringify({
      ...JSON.parse(receivePayload),
      is_outbound: true,
      status: "DELIVERED",
    });
    const res = await app.request(
      PHONE_WEBHOOK_PATH,
      post(statusPayload, { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("forwards outbound status events to the status handler when provided", async () => {
    const handleStatus = vi.fn(async () => undefined);
    const app = new Hono();
    mountPhoneWebhookRoutes(app, {
      signingSecret: SIGNING_SECRET,
      signingHeader: SIGNING_HEADER,
      parseInbound: parseSendBlueInbound,
      handle: vi.fn(async () => undefined),
      handleStatus,
    });
    const statusPayload = JSON.stringify({
      ...JSON.parse(receivePayload),
      is_outbound: true,
      status: "ERROR",
    });
    const res = await app.request(
      PHONE_WEBHOOK_PATH,
      post(statusPayload, { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(res.status).toBe(200);
    expect(handleStatus).toHaveBeenCalledWith({
      type: "status",
      handle: "handle-1",
      status: "ERROR",
    });
  });

  it("acknowledges non-message events and invalid JSON without calling the handler", async () => {
    const { app, handler } = mount();
    const callLog = await app.request(
      PHONE_WEBHOOK_PATH,
      post(JSON.stringify({ event_type: "call_log" }), { [SIGNING_HEADER]: SIGNING_SECRET }),
    );
    const garbage = await app.request(
      PHONE_WEBHOOK_PATH,
      post("not json at all", { [SIGNING_HEADER]: SIGNING_SECRET }),
    );

    expect(callLog.status).toBe(200);
    expect(garbage.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("phone webhook delegate mode", () => {
  it("delegates both GET and POST to the transport and returns its response", async () => {
    const delegate = vi.fn(async (request: Request) =>
      request.method === "GET"
        ? new Response("challenge-echo", { status: 200 })
        : new Response(null, { status: 200 }),
    );
    const app = new Hono();
    mountPhoneWebhookRoutes(app, { delegate });

    const getResponse = await app.request(PHONE_WEBHOOK_PATH, { method: "GET" });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe("challenge-echo");

    const postResponse = await app.request(PHONE_WEBHOOK_PATH, {
      method: "POST",
      body: receivePayload,
      headers: { "content-type": "application/json" },
    });
    expect(postResponse.status).toBe(200);

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.calls[0]![0]).toBeInstanceOf(Request);
  });

  it("surfaces a transport failure as 5xx so platform retries see the failure", async () => {
    const delegate = vi.fn(async () => {
      throw new Error("transport exploded");
    });
    const app = new Hono();
    mountPhoneWebhookRoutes(app, { delegate });

    // Hono's default error handler converts the rejection into a 500; the
    // platform only needs a non-2xx to retry.
    const response = await app.request(PHONE_WEBHOOK_PATH, { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
  });
});
