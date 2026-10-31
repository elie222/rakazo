import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

export type SiteId = "pension" | "invest" | "flights" | "auth";

export interface LabEvent {
  seq: number;
  at: number;
  site: SiteId | "inbox";
  type: string;
  data: Record<string, unknown>;
}

export interface Message {
  id: number;
  at: number;
  channel: "sms" | "email";
  to: string;
  site: SiteId;
  subject?: string;
  body: string;
  code?: string;
}

/**
 * Switches for A/B diagnosis: each one removes a single obstacle so a failing run can be traced
 * to the iframe, the one-time code or the PDF. `POST /api/config` changes them; reset restores them.
 */
export interface LabConfig {
  pension: {
    /** "iframe" serves the login form from another origin; "inline" puts it on the top page. */
    login: "iframe" | "inline";
    /** false skips the one-time code after the ID and phone match. */
    otp: boolean;
    /** true also shows the yearly returns in HTML, not only in the PDFs. */
    html: boolean;
    /**
     * How the code box looks: one plain input; "slots" is one transparent input over six visible
     * digit boxes (input-otp style, the digits only appear in the boxes); "split" is six inputs.
     */
    otpWidget: "single" | "slots" | "split";
  };
}

export const defaultConfig = (): LabConfig => ({
  pension: { login: "iframe", otp: true, html: false, otpWidget: "single" },
});

interface Session {
  userId: string;
  lastSeen: number;
  data: Record<string, unknown>;
}

/** All mutable lab state lives here so a reset is one call. */
export class Lab {
  private clockOffset = 0;
  private seq = 0;
  private msgSeq = 0;
  events: LabEvent[] = [];
  messages: Message[] = [];
  sessions = new Map<string, Session>();
  /** Per-site scratch state (otp challenges, carts, bookings). */
  scratch = new Map<string, unknown>();
  private tokenSeq = 0;
  config: LabConfig = defaultConfig();

  constructor(readonly options: LabOptions = {}) {}

  now(): number {
    return Date.now() + this.clockOffset;
  }

  advanceClock(ms: number): void {
    this.clockOffset += ms;
  }

  reset(): void {
    this.clockOffset = 0;
    this.seq = 0;
    this.msgSeq = 0;
    this.tokenSeq = 0;
    this.config = defaultConfig();
    this.events = [];
    this.messages = [];
    this.sessions.clear();
    this.scratch.clear();
  }

  /** Ports the sites listen on; the pension portal needs the login frame's to build its iframe URL. */
  get ports() {
    const base = this.options.portBase ?? 7000;
    return {
      control: base,
      pension: base + 1,
      invest: base + 2,
      flights: base + 3,
      auth: base + 11,
    };
  }

  /** Scheme of the sites a bot opens. */
  get scheme(): "http" | "https" {
    return this.options.tls ? "https" : "http";
  }

  get delayScale(): number {
    return this.options.delayScale ?? 1;
  }

  get sessionTtlMs(): number {
    return this.options.sessionTtlMs ?? 10 * 60_000;
  }

  /** Deterministic per-run ids: the same actions after a reset give the same tokens. */
  token(prefix: string): string {
    this.tokenSeq += 1;
    return `${prefix}-${hash(`${prefix}:${this.tokenSeq}`).toString(36)}${this.tokenSeq.toString(36)}`;
  }

  log(site: LabEvent["site"], type: string, data: Record<string, unknown> = {}): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, at: this.now(), site, type, data });
  }

  send(msg: Omit<Message, "id" | "at">): Message {
    this.msgSeq += 1;
    const full = { ...msg, id: this.msgSeq, at: this.now() };
    this.messages.push(full);
    this.log("inbox", "message.sent", {
      channel: msg.channel,
      to: msg.to,
      from: msg.site,
    });
    return full;
  }

  state<T>(key: string, init: () => T): T {
    if (!this.scratch.has(key)) this.scratch.set(key, init());
    return this.scratch.get(key) as T;
  }

  startSession(userId: string, data: Record<string, unknown> = {}): string {
    const id = this.token("sess");
    this.sessions.set(id, { userId, lastSeen: this.now(), data });
    return id;
  }

  /** Returns the session if it is alive and counts the call as activity. */
  touch(id: string | undefined): (Session & { id: string }) | "expired" | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() - s.lastSeen > this.sessionTtlMs) {
      this.sessions.delete(id);
      return "expired";
    }
    s.lastSeen = this.now();
    return { ...s, id };
  }
}

export interface LabOptions {
  /** Multiplier for the artificial latency (0 disables it; tests use 0). */
  delayScale?: number;
  sessionTtlMs?: number;
  otpTtlMs?: number;
  resendCooldownMs?: number;
  maxOtpAttempts?: number;
  lockoutMs?: number;
  token?: string;
  /** First of the lab's ports: control = base, pension +1, invest +2, flights +3, login frame +11. */
  portBase?: number;
  /** The sites are served over HTTPS (the control port stays HTTP). */
  tls?: boolean;
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small seeded PRNG so every run of every site shows the same data. */
export function rng(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Israeli ID check digit (Luhn-like, weights 1,2). */
export function isValidIsraeliId(raw: string): boolean {
  if (!/^\d{5,9}$/.test(raw)) return false;
  const id = raw.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

export function israeliIdFromBase(base8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let n = Number(base8[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return base8 + String((10 - (sum % 10)) % 10);
}

export function normalizePhone(p: string): string {
  const d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("+972")) return `0${d.slice(4)}`;
  if (d.startsWith("972")) return `0${d.slice(3)}`;
  return d;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Request/response log for a site, so tests can see everything the agent touched. */
export function requestLogger(lab: Lab, site: SiteId): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/static/") || path === "/favicon.ico") return;
    lab.log(site, "http", { method: c.req.method, path, status: c.res.status });
  };
}

export function sessionOf(lab: Lab, c: Context, cookie: string) {
  return lab.touch(getCookie(c, cookie));
}

export function hostOf(c: Context): string {
  return new URL(c.req.url).hostname;
}
