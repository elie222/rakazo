import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpEmailConfig {
  url: string;
  from: string;
}

interface SmtpEmailDependencies {
  transport?: Transporter;
  createTransport?: (url: string) => Transporter;
  retryDelaysMs?: readonly number[];
  drainTimeoutMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/** SMTP delivery works with SES, Resend, and self-hosted mail servers. */
export class SmtpEmailProvider implements TransactionalEmailProvider {
  private readonly transport: Transporter;
  private readonly retryDelaysMs: readonly number[];
  private readonly drainTimeoutMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private accepting = true;

  constructor(
    private readonly config: SmtpEmailConfig,
    dependencies: SmtpEmailDependencies = {},
  ) {
    const secureUrl = secureSmtpUrl(config.url);
    const protocol = safeProtocol(secureUrl);
    if (protocol !== "smtp:" && protocol !== "smtps:") {
      throw new Error("SMTP_URL must use smtp:// or smtps://");
    }
    if (!config.from.trim()) throw new Error("EMAIL_FROM is required when SMTP_URL is configured");
    this.transport =
      dependencies.transport ??
      (dependencies.createTransport ?? nodemailer.createTransport)(secureUrl);
    this.retryDelaysMs = dependencies.retryDelaysMs ?? [250, 1_000];
    this.drainTimeoutMs = dependencies.drainTimeoutMs ?? 10_000;
    this.sleep = dependencies.sleep ?? wait;
  }

  describe() {
    return {
      id: "smtp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("SMTP provider is shutting down"));
    const delivery = this.deliver(message);
    this.inFlight.add(delivery);
    void delivery.then(
      () => this.inFlight.delete(delivery),
      () => this.inFlight.delete(delivery),
    );
    return delivery;
  }

  async drain(): Promise<void> {
    this.accepting = false;
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.inFlight.size > 0) {
      const completed = await settlesWithin(this.inFlight, Math.max(0, deadline - Date.now()));
      if (completed) continue;
      this.shutdown.abort();
      this.inFlight.clear();
      try {
        this.transport.close();
      } catch {
        // Cleanup must continue even when the transport cannot close cleanly.
      }
      return;
    }
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.shutdown.signal.aborted) {
        throw new Error("SMTP delivery stopped during shutdown");
      }
      try {
        await this.transport.sendMail({
          from: this.config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return;
      } catch (error) {
        if (this.shutdown.signal.aborted) throw error;
        const retryDelay = this.retryDelaysMs[attempt];
        if (retryDelay === undefined) throw error;
        await this.sleep(retryDelay, this.shutdown.signal);
      }
    }
  }
}

function secureSmtpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  const parameters = new Map(
    [...parsed.searchParams].map(([key, setting]) => [key.toLowerCase(), setting.toLowerCase()]),
  );
  if (
    parameters.get("ignoretls") === "true" ||
    parameters.get("requiretls") === "false" ||
    parameters.get("tls.rejectunauthorized") === "false" ||
    (parsed.protocol === "smtps:" && parameters.get("secure") === "false")
  ) {
    throw new Error("SMTP_URL cannot disable TLS or certificate verification");
  }
  if (parsed.protocol === "smtp:") parsed.searchParams.set("requireTLS", "true");
  return parsed.href;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("SMTP delivery stopped during shutdown"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("SMTP delivery stopped during shutdown"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settlesWithin(
  promises: Iterable<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...promises]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}
