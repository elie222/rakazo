import { type Lab, rng, type SiteId } from "./core.js";

interface Challenge {
  code?: string;
  expiresAt: number;
  lastSentAt: number;
  sends: number;
  attempts: number;
  lockedUntil: number;
}

export type OtpFailure =
  | { ok: false; reason: "cooldown"; retryAfterMs: number }
  | { ok: false; reason: "locked"; retryAfterMs: number }
  | { ok: false; reason: "expired" | "no_code" }
  | { ok: false; reason: "wrong"; attemptsLeft: number };

/** One-time codes with expiry, resend cooldown and lockout, delivered through the lab inbox. */
export class Otp {
  constructor(
    private lab: Lab,
    private site: SiteId,
  ) {}

  private get ttl() {
    return this.lab.options.otpTtlMs ?? 5 * 60_000;
  }
  private get cooldown() {
    return this.lab.options.resendCooldownMs ?? 30_000;
  }
  private get maxAttempts() {
    return this.lab.options.maxOtpAttempts ?? 3;
  }
  private get lockout() {
    return this.lab.options.lockoutMs ?? 15 * 60_000;
  }

  private map() {
    return this.lab.state(`otp:${this.site}`, () => new Map<string, Challenge>());
  }

  send(
    key: string,
    channel: "sms" | "email",
    to: string,
  ):
    | { ok: true; cooldownMs: number; ttlMs: number }
    | Extract<OtpFailure, { reason: "cooldown" | "locked" }> {
    const now = this.lab.now();
    const ch = this.map().get(key) ?? {
      expiresAt: 0,
      lastSentAt: -Infinity,
      sends: 0,
      attempts: 0,
      lockedUntil: 0,
    };
    if (ch.lockedUntil > now) {
      return { ok: false, reason: "locked", retryAfterMs: ch.lockedUntil - now };
    }
    if (now - ch.lastSentAt < this.cooldown) {
      return { ok: false, reason: "cooldown", retryAfterMs: this.cooldown - (now - ch.lastSentAt) };
    }
    ch.sends += 1;
    const code = String(Math.floor(rng(`${this.site}:${key}:${ch.sends}`)() * 900000) + 100000);
    ch.code = code;
    ch.expiresAt = now + this.ttl;
    ch.lastSentAt = now;
    ch.attempts = 0;
    this.map().set(key, ch);
    const minutes = Math.round(this.ttl / 60000);
    this.lab.send({
      channel,
      to,
      site: this.site,
      subject: channel === "email" ? "קוד אימות" : undefined,
      body: `קוד האימות שלך הוא ${code}. תקף ל-${minutes} דקות. Verification code: ${code}`,
      code,
    });
    this.lab.log(this.site, "otp.sent", { key, channel, to, send: ch.sends });
    return { ok: true, cooldownMs: this.cooldown, ttlMs: this.ttl };
  }

  verify(key: string, submitted: string): { ok: true } | OtpFailure {
    const now = this.lab.now();
    const ch = this.map().get(key);
    const done = (r: { ok: true } | OtpFailure) => {
      this.lab.log(this.site, "otp.verify", {
        key,
        submitted,
        ok: r.ok,
        reason: r.ok ? null : r.reason,
      });
      return r;
    };
    if (ch && ch.lockedUntil > now)
      return done({ ok: false, reason: "locked", retryAfterMs: ch.lockedUntil - now });
    if (!ch?.code) return done({ ok: false, reason: "no_code" });
    if (now > ch.expiresAt) {
      ch.code = undefined;
      return done({ ok: false, reason: "expired" });
    }
    if (submitted.trim() !== ch.code) {
      ch.attempts += 1;
      if (ch.attempts >= this.maxAttempts) {
        ch.lockedUntil = now + this.lockout;
        ch.code = undefined;
        return done({ ok: false, reason: "locked", retryAfterMs: this.lockout });
      }
      return done({ ok: false, reason: "wrong", attemptsLeft: this.maxAttempts - ch.attempts });
    }
    ch.code = undefined;
    return done({ ok: true });
  }
}

export function failureText(f: OtpFailure): string {
  switch (f.reason) {
    case "wrong":
      return `הקוד שגוי. נותרו ${f.attemptsLeft} ניסיונות.`;
    case "expired":
      return "תוקף הקוד פג. יש לבקש קוד חדש.";
    case "locked":
      return `הכניסה ננעלה זמנית עקב ניסיונות כושלים. נסו שוב בעוד ${Math.ceil(f.retryAfterMs / 60000)} דקות.`;
    case "cooldown":
      return `ניתן לבקש קוד חדש בעוד ${Math.ceil(f.retryAfterMs / 1000)} שניות.`;
    default:
      return "לא נשלח קוד. יש לבקש קוד חדש.";
  }
}
