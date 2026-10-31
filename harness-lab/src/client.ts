import type { LabConfig, LabEvent, Message } from "./lib/core.js";

export type { LabConfig, LabEvent, Message };

/** Ports of the lab sites, the one place callers learn them. */
const DEFAULT_PORT_BASE = 7000;

export const labPorts = (base: number) =>
  ({ control: base, pension: base + 1, invest: base + 2, flights: base + 3 }) as const;

/**
 * Talks to a running lab's control API from the machine running the benchmark. The sites the bot
 * opens are reached through a different, bot-facing host (see `botUrl`), because the bot's
 * computer cannot use loopback.
 */
export class LabClient {
  constructor(
    readonly controlUrl = process.env.HARNESS_LAB_URL ?? `http://127.0.0.1:${DEFAULT_PORT_BASE}`,
    /** Host the bot's computer uses to reach the sites, by default host.docker.internal (the host machine, where the lab ports are published on loopback). */
    readonly botHost = process.env.HARNESS_LAB_BOT_HOST ?? "host.docker.internal",
    private token = process.env.HARNESS_LAB_TOKEN,
    /** Must match the lab instance's HARNESS_LAB_PORT_BASE (default 7000). */
    readonly portBase = Number(process.env.HARNESS_LAB_PORT_BASE ?? DEFAULT_PORT_BASE),
    /** The sites are HTTPS by default (a lab CA the bot's computer trusts); set http for a plain lab. */
    readonly botScheme = process.env.HARNESS_LAB_BOT_SCHEME ?? "https",
  ) {}

  botUrl(site: "pension" | "invest" | "flights"): string {
    return `${this.botScheme}://${this.botHost}:${labPorts(this.portBase)[site]}`;
  }

  private headers(): Headers {
    const headers = new Headers();
    if (this.token) headers.set("x-lab-token", this.token);
    return headers;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = this.headers();
    for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
    if (init?.body) headers.set("content-type", "application/json");
    let res: Response;
    try {
      res = await fetch(`${this.controlUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new Error(
        `Harness lab is not reachable at ${this.controlUrl} (${error instanceof Error ? error.message : error}); start it with \`pnpm --filter @rakazo/harness-lab start\` or the harness-lab/mocks container`,
      );
    }
    if (!res.ok) throw new Error(`Harness lab ${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  health() {
    return this.call<{ ok: boolean; now: number }>("/api/health");
  }
  reset() {
    return this.call<{ ok: boolean }>("/api/reset", { method: "POST" });
  }
  setConfig(config: { pension?: Partial<LabConfig["pension"]> }) {
    return this.call<LabConfig>("/api/config", { method: "POST", body: JSON.stringify(config) });
  }
  async latestCode(to: string, site?: string): Promise<string | undefined> {
    const q = new URLSearchParams({ to, ...(site ? { site } : {}) });
    const res = await fetch(`${this.controlUrl}/api/latest-code?${q}`, { headers: this.headers() });
    return res.ok ? ((await res.json()) as { code: string }).code : undefined;
  }
  messages(to?: string) {
    return this.call<{ messages: Message[] }>(
      `/api/messages${to ? `?to=${encodeURIComponent(to)}` : ""}`,
    );
  }
  async events(filter: { site?: string; type?: string; since?: number } = {}): Promise<LabEvent[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined) q.set(k, String(v));
    return (await this.call<{ events: LabEvent[] }>(`/api/events?${q}`)).events;
  }
}
