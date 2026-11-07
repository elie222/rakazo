import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { CloudflareEmailProvider } from "./cloudflare-email.js";

const config = {
  apiKey: "fake-api-key",
  accountId: "0123456789abcdef0123456789abcdef",
  from: "hello@example.test",
  replyTo: "replies@example.test",
};
const message = { to: "user@example.test", subject: "Reset password", text: "Reset link" };

function result(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "email-1",
    delivered: [message.to],
    queued: [],
    permanent_bounces: [],
    suppressed_recipients: [],
    ...overrides,
  };
}

function envelope(value: unknown = result()) {
  return { success: true, errors: [], messages: [], result: value };
}

function provider(request: typeof fetch, timeoutMs = 1_000) {
  return new CloudflareEmailProvider(config, { fetch: request, timeoutMs });
}

function mailbox(value: string | { address: string; name?: string }) {
  if (typeof value !== "string") return value.address;
  return value.match(/<([^<>]+)>$/)?.[1] ?? value;
}

function mailboxes(value: string | string[] | { address: string; name?: string }) {
  return (Array.isArray(value) ? value : [value]).map(mailbox);
}

describe("CloudflareEmailProvider", () => {
  it("submits rendered content to the fixed account endpoint without redirects", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope()));
    const email: TransactionalEmailProvider = provider(request);
    const content: TransactionalEmail = {
      ...message,
      html: "<p>Reset link</p>",
      headers: { "List-Unsubscribe": "<https://app.example.test/unsubscribe?token=fake>" },
    };
    expect(email.describe()).toMatchObject({
      id: "cloudflare",
      contractVersion: "1",
      capabilities: { transactional: true },
    });
    await expect(email.send(content)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${config.apiKey}`);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      from: config.from,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: content.headers,
      reply_to: config.replyTo,
    });
    expect(mailboxes(body.to)).toEqual([message.to]);
    expect(body).not.toHaveProperty("replyTo");
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("accountId");
  });

  it("preserves sender/reply-to overrides and all to/cc recipients", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        envelope(
          result({
            delivered: [message.to, "other@example.test"],
            queued: ["copy@example.test"],
          }),
        ),
      ),
    );
    await provider(request).send({
      ...message,
      to: [message.to, "other@example.test"],
      cc: ["copy@example.test"],
      from: "Scout <scout@example.test>",
      replyTo: "scout@example.test",
    });
    const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(mailbox(body.from)).toBe("scout@example.test");
    expect(mailboxes(body.to)).toEqual([message.to, "other@example.test"]);
    expect(mailboxes(body.cc)).toEqual(["copy@example.test"]);
    expect(mailbox(body.reply_to)).toBe("scout@example.test");
    expect(body).not.toHaveProperty("replyTo");
  });

  it.each(["delivered", "queued"])("accepts an intended recipient in %s", async (outcome) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(envelope(result({ delivered: [], [outcome]: [message.to] }))),
      );
    await expect(provider(request).send(message)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["permanent_bounces", "suppressed_recipients"])(
    "rejects an intended recipient in %s even when another recipient is accepted",
    async (outcome) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(envelope(result({ [outcome]: ["copy@example.test"] }))));
      await expect(
        provider(request).send({ ...message, cc: ["copy@example.test"] }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "no intended recipient", value: result({ delivered: ["other@example.test"] }) },
    { name: "missing result", value: null },
    { name: "only a message ID", value: { message_id: "email-1" } },
    { name: "malformed outcomes", value: result({ delivered: message.to }) },
    { name: "non-string outcomes", value: result({ delivered: [null] }) },
  ])("rejects $name", async ({ value }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope(value)));
    await expect(provider(request).send(message)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires an accepted outcome for every to and cc recipient", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope()));
    await expect(
      provider(request).send({
        ...message,
        to: [message.to, "missing@example.test"],
        cc: ["copy@example.test"],
      }),
    ).rejects.toThrow();
  });

  it("rejects a failed API envelope without exposing provider-controlled details", async () => {
    const secret = `${config.apiKey} private-recipient@example.test`;
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...envelope(),
        success: false,
        errors: [{ code: 10000, message: secret }],
      }),
    );
    const failure = await provider(request)
      .send(message)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(config.apiKey);
    expect(String(failure)).not.toContain("private-recipient@example.test");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 500, 503])(
    "rejects HTTP %s without retrying or leaking its body",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`${config.apiKey} private-recipient@example.test`, { status }),
        );
      const failure = await provider(request)
        .send(message)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(config.apiKey);
      expect(String(failure)).not.toContain("private-recipient@example.test");
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("does not retry an ambiguous network failure or expose its cause", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${config.apiKey} private-recipient@example.test`));
    const failure = await provider(request)
      .send(message)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(config.apiKey);
    expect(String(failure)).not.toContain("private-recipient@example.test");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["not JSON", "{}", '{"success":true,"result":'])(
    "rejects an invalid JSON response (%s)",
    async (body) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(provider(request).send(message)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])("bounds oversized responses (declared length: %s)", async (declared) => {
    const body = JSON.stringify({ ...envelope(), padding: "x".repeat(1024 * 1024) });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: declared ? { "content-length": String(body.length) } : {} }),
      );
    await expect(provider(request).send(message)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["request", "body"])(
    "bounds a stalled %s and lets drain complete",
    async (phase) => {
      const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        if (phase === "request") {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        }
        return new Response(new ReadableStream<Uint8Array>());
      });
      const email = provider(request, 20);
      const delivery = expect(email.send(message)).rejects.toThrow(/timed out|timeout/i);
      await email.drain();
      await delivery;
      await expect(email.send(message)).rejects.toThrow(/shutting down/i);
      expect(request).toHaveBeenCalledOnce();
    },
    2_000,
  );

  it.each([true, false])(
    "drain waits for in-flight delivery (accepted: %s) and refuses new sends",
    async (accepted) => {
      let finish!: (response: Response) => void;
      const request = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const email = provider(request);
      const delivery = email.send(message);
      const checked = accepted
        ? expect(delivery).resolves.toBeUndefined()
        : expect(delivery).rejects.toThrow();
      const drained = vi.fn();
      const draining = email.drain().then(drained);
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      await expect(email.send(message)).rejects.toThrow(/shutting down/i);
      expect(request).toHaveBeenCalledOnce();
      finish(accepted ? Response.json(envelope()) : new Response("rejected", { status: 403 }));
      await checked;
      await draining;
      await email.drain();
      expect(drained).toHaveBeenCalledOnce();
    },
  );

  it.each(["apiKey", "accountId", "from"] as const)("fails early on missing %s", (field) => {
    expect(() => new CloudflareEmailProvider({ ...config, [field]: " " })).toThrow();
  });

  it.each(["../other", "abc?redirect=evil", "https://evil.example.test", "short"])(
    "rejects an unsafe or invalid account ID (%s) before any request",
    (accountId) => {
      const request = vi.fn<typeof fetch>();
      expect(
        () => new CloudflareEmailProvider({ ...config, accountId }, { fetch: request }),
      ).toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
