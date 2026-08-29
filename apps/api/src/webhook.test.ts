import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  formatWebhookPrompt,
  mountWebhookHttpRoutes,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_SECRET_KIND,
  type WebhookDeps,
} from "./webhook.js";

const SECRET = "webhook-test-secret-value-32chars!!";

function createDeps(
  overrides: {
    bot?: {
      id: string;
      workspaceId: string;
      userId: string;
      webhookSecretId: string | null;
      thread: { id: string } | null;
    } | null;
    secret?: { ciphertext: string; kind: string; userId: string; workspaceId: string } | null;
    load?: (ciphertext: string) => string;
  } = {},
): WebhookDeps & {
  sendUserMessage: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const bot =
    overrides.bot === undefined
      ? {
          id: "bot-1",
          workspaceId: "ws-1",
          userId: "user-1",
          webhookSecretId: "secret-1",
          thread: { id: "thread-1" },
        }
      : overrides.bot;
  const secret =
    overrides.secret === undefined
      ? {
          ciphertext: "cipher",
          kind: WEBHOOK_SECRET_KIND,
          userId: "user-1",
          workspaceId: "ws-1",
        }
      : overrides.secret;

  const sendUserMessage = vi.fn(async () => ({
    messageId: "msg-1",
    runId: "run-1",
    seq: 3,
  }));
  const enqueue = vi.fn(async () => undefined);

  return {
    prisma: {
      bot: {
        findUnique: vi.fn(async () => bot),
      },
      secret: {
        findUnique: vi.fn(async () => secret),
      },
      routine: {
        findMany: vi.fn(async () => []),
      },
    } as unknown as WebhookDeps["prisma"],
    secrets: {
      load: overrides.load ?? (() => SECRET),
    } as unknown as WebhookDeps["secrets"],
    events: { sendUserMessage },
    jobs: { enqueue } as unknown as WebhookDeps["jobs"],
    sendUserMessage,
    enqueue,
  };
}

function mount(deps: WebhookDeps) {
  const app = new Hono();
  mountWebhookHttpRoutes(app, deps);
  return app;
}

describe("formatWebhookPrompt", () => {
  it("uses payload.text when present", () => {
    expect(formatWebhookPrompt({ text: " Deployment ok " })).toBe("Deployment ok");
  });

  it("formats json events with a fence", () => {
    const prompt = formatWebhookPrompt({ event: "github.push", ref: "main" });
    expect(prompt).toContain("[Inbound Event: github.push]");
    expect(prompt).toContain('"ref": "main"');
  });
});

describe("inbound webhook HTTP route", () => {
  it("rejects missing authorization", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects the wrong bearer secret", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects unknown bots with the same unauthorized response", async () => {
    const deps = createDeps({ bot: null });
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/missing/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects bots without a configured webhook secret", async () => {
    const deps = createDeps({
      bot: {
        id: "bot-1",
        workspaceId: "ws-1",
        userId: "user-1",
        webhookSecretId: null,
        thread: { id: "thread-1" },
      },
    });
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("accepts a valid secret and JSON payload", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "ci.failed", repo: "rakazo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      messageId: "msg-1",
      runId: "run-1",
      seq: 3,
    });
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-1",
        trigger: "webhook",
        prompt: expect.stringContaining("[Inbound Event: ci.failed]"),
      }),
    );
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it("accepts a plain text payload", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "text/plain",
      },
      body: "Staging deploy finished",
    });
    expect(res.status).toBe(200);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "webhook",
        prompt: "Staging deploy finished",
      }),
    );
  });

  it("hashes idempotency keys into a fixed-length clientNonce", async () => {
    const { createHash } = await import("node:crypto");
    const deps = createDeps();
    const app = mount(deps);
    const longKey = `event-${"a".repeat(240)}-unique-suffix`;
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        "idempotency-key": longKey,
      },
      body: JSON.stringify({ event: "ping" }),
    });
    expect(res.status).toBe(200);
    const digest = createHash("sha256").update(longKey).digest("base64url");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientNonce: `webhook:bot-1:${digest}`,
      }),
    );
  });

  it("rejects oversized payloads", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "text/plain",
        "content-length": String(WEBHOOK_MAX_BODY_BYTES + 1),
      },
      body: "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });
});
