import type { Hono } from "hono";
import { Lab, type LabOptions } from "./lib/core.js";

/** Tiny cookie-keeping client around app.request, so tests read like a browser session. */
/** Response whose json() is loosely typed, since tests only poke at fields. */
export type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

export class Client {
  private cookies = new Map<string, string>();
  constructor(private app: Hono) {}

  async req(path: string, init: RequestInit = {}): Promise<TestResponse> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await this.app.request(`http://lab.test${path}`, { ...init, headers });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair!.split("=");
      this.cookies.set(k!, v.join("="));
    }
    return res;
  }

  form(path: string, data: Record<string, string>) {
    return this.req(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString(),
    });
  }

  json(path: string, data: unknown) {
    return this.req(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  }
}

export const newLab = (o: LabOptions = {}) => new Lab({ delayScale: 0, ...o });

export function latestCode(lab: Lab, to: string): string {
  const m = lab.messages.filter((x) => x.to === to && x.code).at(-1);
  if (!m) throw new Error(`no code for ${to}`);
  return m.code!;
}
