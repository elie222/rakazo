import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SmtpEmailProvider } from "./smtp-email.js";

describe("SmtpEmailProvider", () => {
  it("delivers product-authored content through the injected transport", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      { url: "smtps://user:secret@smtp.example.test:465", from: "Rakazo <no-reply@example.test>" },
      { transport: { sendMail } as never },
    );

    await provider.send({
      to: "ada@example.test",
      subject: "Reset password",
      text: "Plain text",
      html: "<p>HTML</p>",
    });

    expect(provider.describe().id).toBe("smtp");
    expect(sendMail).toHaveBeenCalledWith({
      from: "Rakazo <no-reply@example.test>",
      to: "ada@example.test",
      subject: "Reset password",
      text: "Plain text",
      html: "<p>HTML</p>",
    });
  });

  it("retries transient failures and drains tracked delivery", async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ messageId: "message-1" });
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { sendMail } as never, sleep },
    );

    const delivery = provider.send({
      to: "ada@example.test",
      subject: "Reset password",
      text: "Use this link",
    });
    await provider.drain();
    await expect(delivery).resolves.toBeUndefined();

    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 1_000]);
  });

  it("rejects deliveries after draining begins", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const provider = new SmtpEmailProvider(
      { url: "smtp://smtp.example.test", from: "a@example.test" },
      { transport: { sendMail } as never },
    );

    await provider.drain();

    await expect(
      provider.send({
        to: "ada@example.test",
        subject: "Reset password",
        text: "Use this link",
      }),
    ).rejects.toThrow("SMTP provider is shutting down");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("bounds graceful shutdown when delivery never settles", async () => {
    vi.useFakeTimers();
    try {
      const sendMail = vi.fn(() => new Promise<never>(() => undefined));
      const close = vi.fn();
      const provider = new SmtpEmailProvider(
        { url: "smtp://smtp.example.test", from: "a@example.test" },
        {
          transport: { sendMail, close } as never,
          retryDelaysMs: [],
          drainTimeoutMs: 100,
        },
      );

      void provider
        .send({ to: "ada@example.test", subject: "Reset password", text: "Use this link" })
        .catch(() => undefined);
      const draining = provider.drain();
      await vi.advanceTimersByTimeAsync(100);

      await expect(draining).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the drain deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const sendMail = vi.fn(async () => Promise.reject(new Error("temporary failure")));
      const close = vi.fn();
      const provider = new SmtpEmailProvider(
        { url: "smtp://smtp.example.test", from: "a@example.test" },
        {
          transport: { sendMail, close } as never,
          retryDelaysMs: [10_000],
          drainTimeoutMs: 100,
        },
      );

      const delivery = provider
        .send({
          to: "ada@example.test",
          subject: "Reset password",
          text: "Use this link",
        })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      const draining = provider.drain();
      await vi.advanceTimersByTimeAsync(100);

      await expect(draining).resolves.toBeUndefined();
      await delivery;
      expect(sendMail).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsafe transports and incomplete sender configuration", () => {
    expect(
      () => new SmtpEmailProvider({ url: "https://smtp.example.test", from: "a@example.test" }),
    ).toThrow("SMTP_URL must use smtp:// or smtps://");
    expect(() => new SmtpEmailProvider({ url: "smtp://smtp.example.test", from: "" })).toThrow(
      "EMAIL_FROM is required",
    );
    expect(
      () =>
        new SmtpEmailProvider({
          url: "smtp://smtp.example.test?ignoreTLS=true",
          from: "a@example.test",
        }),
    ).toThrow("cannot disable TLS");
    expect(
      () =>
        new SmtpEmailProvider({
          url: "smtps://smtp.example.test?tls.rejectUnauthorized=false",
          from: "a@example.test",
        }),
    ).toThrow("cannot disable TLS");
  });

  it("requires STARTTLS for smtp URLs", () => {
    const createTransport = vi.fn((_url: string) => ({ sendMail: vi.fn() }) as never);

    new SmtpEmailProvider(
      { url: "smtp://user:secret@smtp.example.test:587", from: "a@example.test" },
      { createTransport },
    );

    expect(createTransport).toHaveBeenCalledOnce();
    const configuredUrl = new URL(String(createTransport.mock.calls[0]?.[0]));
    expect(configuredUrl.protocol).toBe("smtp:");
    expect(configuredUrl.searchParams.get("requireTLS")).toBe("true");
  });

  it("rejects an smtp relay that does not advertise STARTTLS", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost ESMTP\r\n");
      socket.on("data", (chunk) => {
        for (const line of String(chunk).split("\r\n")) {
          if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 HELP\r\n");
          else if (/^STARTTLS$/i.test(line)) socket.write("454 TLS not available\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
    const provider = new SmtpEmailProvider(
      {
        url: `smtp://127.0.0.1:${address.port}?connectionTimeout=1000`,
        from: "a@example.test",
      },
      { retryDelaysMs: [] },
    );

    try {
      await expect(
        provider.send({ to: "ada@example.test", subject: "Reset", text: "Use this link" }),
      ).rejects.toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
