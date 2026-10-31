import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Lab } from "./lib/core.js";
import { startSites } from "./main.js";

const script = fileURLToPath(new URL("../scripts/lab-ca.sh", import.meta.url));
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("TLS mode", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lab-ca-"));
  const BASE = 7500;
  let servers: ReturnType<typeof startSites> = [];
  afterAll(() => {
    for (const s of servers) s.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, ca: Buffer) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(url, { ca }, (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("serves the sites over HTTPS with the lab CA, the login iframe too, and the control port over HTTP", async () => {
    execFileSync(script, [dir], { stdio: "pipe" });
    const ca = readFileSync(path.join(dir, "ca.crt"));
    const lab = new Lab({ delayScale: 0, portBase: BASE, tls: true, token: "t" });
    servers = startSites(lab, "127.0.0.1", path.join(dir, "server"));
    await new Promise((r) => setTimeout(r, 300));

    const login = await get(`https://localhost:${BASE + 1}/login`, ca);
    expect(login.status).toBe(200);
    expect(login.body).toContain(`src="https://localhost:${BASE + 11}/embed/login"`);
    const frame = await get(`https://localhost:${BASE + 11}/embed/login`, ca);
    expect(frame.status).toBe(200);
    // Not trusted without the CA.
    await expect(get(`https://localhost:${BASE + 2}/`, Buffer.alloc(0))).rejects.toThrow();
    const control = await fetch(`http://127.0.0.1:${BASE}/api/health`, {
      headers: { "x-lab-token": "t" },
    });
    expect(control.status).toBe(200);
  });
});
