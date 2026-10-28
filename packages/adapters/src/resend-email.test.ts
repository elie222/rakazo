import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "./resend-email.js";

const config = { apiKey: "fake-api-key", from: "Rakazo <hello@example.test>" };
const message = { to: "user@example.test", subject: "Reset password", text: "Reset link" };

function provider(request: typeof fetch, timeoutMs = 1_000) {
  return new ResendEmailProvider(config, { fetch: request, retryDelaysMs: [0, 0], timeoutMs });
}

describe("ResendEmailProvider", () => {
  it("retries lost responses, throttling and server failures with the same opaque key", async () => {
    for (const failure of [new Error("socket lost"), 429, 500]) {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          if (failure instanceof Error) throw failure;
          return new Response("untrusted provider body", { status: failure });
        })
        .mockResolvedValueOnce(Response.json({ id: "email-1" }));
      await provider(request).send(message);
      expect(request).toHaveBeenCalledTimes(2);
      const first = request.mock.calls[0]!;
      const second = request.mock.calls[1]!;
      expect(first[0]).toBe("https://api.resend.com/emails");
      expect(first[1]).toMatchObject({ method: "POST", redirect: "error" });
      expect(first[1]!.headers).toEqual(second[1]!.headers);
      expect(first[1]!.headers).toMatchObject({ authorization: "Bearer fake-api-key" });
      expect(JSON.parse(first[1]!.body as string)).toEqual({ from: config.from, ...message });
    }
  });

  it("sends the configured reply-to address", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email-1" }));
    await new ResendEmailProvider(
      { ...config, replyTo: "founder@example.test" },
      { fetch: request },
    ).send(message);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
      reply_to: "founder@example.test",
    });
  });

  it("gives separate deliveries different keys", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "email-1" }));
    const email = provider(request);
    await email.send(message);
    await email.send(message);
    const headers = request.mock.calls.map(([, init]) => new Headers(init!.headers));
    expect(headers[0]!.get("idempotency-key")).not.toBe(headers[1]!.get("idempotency-key"));
  });

  it.each([400, 401, 403, 409, 422])(
    "does not retry HTTP %s or expose the response body",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private recipient and secret", { status }));
      await expect(provider(request).send(message)).rejects.toThrow(
        `Resend email request failed (HTTP ${status})`,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("names Resend's validation error without the recipient", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          statusCode: 422,
          name: "validation_error",
          message: "Invalid `to` field: user@example.test",
        },
        { status: 422 },
      ),
    );
    await expect(provider(request).send(message)).rejects.toThrow(
      /^Resend email request failed \(HTTP 422: validation_error: Invalid `to` field: <address>\)$/,
    );
  });

  it("does not read an oversized error body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ name: "validation_error", message: "x".repeat(10_000) }, { status: 422 }),
      );
    await expect(provider(request).send(message)).rejects.toThrow(
      /^Resend email request failed \(HTTP 422\)$/,
    );
  });

  it("bounds retries and strips network errors", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("private credentials"));
    await expect(provider(request).send(message)).rejects.toThrow(/^Resend email request failed$/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("requires a valid success response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: "private" }));
    await expect(provider(request).send(message)).rejects.toThrow("invalid email response");
  });

  it("bounds a stalled response body and drains without accepting new sends", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const email = provider(request, 20);
    const delivery = expect(email.send(message)).rejects.toThrow("timed out");
    await email.drain();
    await delivery;
    await expect(email.send(message)).rejects.toThrow("shutting down");
  });

  it("waits for accepted delivery on shutdown", async () => {
    let complete!: (response: Response) => void;
    const email = provider(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const delivery = email.send(message);
    const drained = vi.fn();
    const draining = email.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    complete(Response.json({ id: "email-1" }));
    await delivery;
    await draining;
    expect(drained).toHaveBeenCalledOnce();
  });

  it("fails early on incomplete configuration", () => {
    expect(() => new ResendEmailProvider({ ...config, apiKey: " " })).toThrow("EMAIL_API_KEY");
    expect(() => new ResendEmailProvider({ ...config, from: " " })).toThrow("EMAIL_FROM");
  });
});
