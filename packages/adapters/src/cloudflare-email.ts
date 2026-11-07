import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";
import addressparser from "nodemailer/lib/addressparser/index.js";

const MAX_RESPONSE_BYTES = 65_536;

interface CloudflareEmailConfig {
  apiKey: string;
  accountId: string;
  from: string;
  replyTo?: string;
}

interface CloudflareEmailDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class CloudflareEmailProvider implements TransactionalEmailProvider {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly config: CloudflareEmailConfig,
    dependencies: CloudflareEmailDependencies = {},
  ) {
    if (!config.apiKey.trim()) throw new Error("EMAIL_API_KEY is required for Cloudflare");
    if (!/^[a-f0-9]{32}$/i.test(config.accountId))
      throw new Error("EMAIL_ACCOUNT_ID must be a 32-character hexadecimal account ID");
    if (!config.from.trim()) throw new Error("EMAIL_FROM is required for Cloudflare");
    this.request = dependencies.fetch ?? fetch;
    this.timeoutMs = dependencies.timeoutMs ?? 10_000;
  }

  describe() {
    return {
      id: "cloudflare",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("Email provider is shutting down"));
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
    await Promise.allSettled([...this.inFlight]);
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const to = (Array.isArray(message.to) ? message.to : [message.to]).map(mailbox);
      const cc = message.cc?.map(mailbox);
      const recipients = [...to, ...(cc ?? [])].map((item) =>
        typeof item === "string" ? item : item.address,
      );
      if (!recipients.length) throw new Error();
      const { from, replyTo, cc: _cc, to: _to, ...rest } = message;
      const reply = replyTo ?? this.config.replyTo;
      const response = await this.request(
        `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/email/sending/send`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: mailbox(from ?? this.config.from),
            ...(reply ? { reply_to: mailbox(reply) } : {}),
            to: Array.isArray(message.to) ? to : to[0],
            ...(cc?.length ? { cc } : {}),
            ...rest,
          }),
          signal,
        },
      );
      if (!response.ok) {
        cancelResponseBody(response);
        throw new Error();
      }
      const envelope: unknown = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, signal);
      if (!accepted(envelope, recipients)) throw new Error();
    } catch {
      if (signal.aborted) throw new Error("Cloudflare email delivery timed out");
      throw new Error("Cloudflare email delivery failed");
    }
  }
}

function mailbox(value: string): string | { address: string; name: string } {
  const parsed = addressparser(value, { flatten: true });
  if (parsed.length !== 1 || !parsed[0]?.address) throw new Error();
  const { address, name } = parsed[0];
  return name ? { address, name } : address;
}

function accepted(envelope: unknown, recipients: string[]): boolean {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("success" in envelope) ||
    envelope.success !== true ||
    !("result" in envelope)
  )
    return false;
  const result = envelope.result;
  if (typeof result !== "object" || result === null) return false;
  const outcomes = result as Record<string, unknown>;
  const keys = ["delivered", "queued", "permanent_bounces"] as const;
  if (
    !keys.every(
      (key) =>
        Array.isArray(outcomes[key]) &&
        outcomes[key].every((item: unknown) => typeof item === "string"),
    )
  )
    return false;
  const suppressed = "suppressed_recipients" in outcomes ? outcomes.suppressed_recipients : [];
  if (!Array.isArray(suppressed) || !suppressed.every((item: unknown) => typeof item === "string"))
    return false;
  const delivered = outcomes.delivered as string[];
  const queued = outcomes.queued as string[];
  if ((outcomes.permanent_bounces as string[]).length || suppressed.length) return false;
  const acceptedRecipients = new Set(
    [...delivered, ...queued].map((address) => address.toLowerCase()),
  );
  return recipients.every((address) => acceptedRecipients.has(address.toLowerCase()));
}
