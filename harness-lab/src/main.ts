import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Lab, type LabOptions } from "./lib/core.js";

export { Lab };

import { flightsSite } from "./sites/flights.js";
import { inboxSite } from "./sites/inbox.js";
import { investSite } from "./sites/invest.js";
import { pensionAuthSite, pensionSite } from "./sites/pension.js";

export function buildSites(lab: Lab): { name: string; port: number; app: Hono }[] {
  return [
    { name: "inbox+control", port: lab.ports.control, app: inboxSite(lab) },
    { name: "pension", port: lab.ports.pension, app: pensionSite(lab) },
    { name: "pension-auth (login iframe origin)", port: lab.ports.auth, app: pensionAuthSite(lab) },
    { name: "invest", port: lab.ports.invest, app: investSite(lab) },
    { name: "flights", port: lab.ports.flights, app: flightsSite(lab) },
  ];
}

export function optionsFromEnv(env = process.env): LabOptions {
  const num = (k: string) => (env[k] === undefined ? undefined : Number(env[k]));
  return {
    delayScale: num("HARNESS_LAB_DELAY_SCALE"),
    sessionTtlMs: num("HARNESS_LAB_SESSION_TTL_MS"),
    otpTtlMs: num("HARNESS_LAB_OTP_TTL_MS"),
    resendCooldownMs: num("HARNESS_LAB_RESEND_COOLDOWN_MS"),
    maxOtpAttempts: num("HARNESS_LAB_MAX_OTP_ATTEMPTS"),
    lockoutMs: num("HARNESS_LAB_LOCKOUT_MS"),
    token: env.HARNESS_LAB_TOKEN,
    portBase: num("HARNESS_LAB_PORT_BASE"),
    tls: Boolean(env.HARNESS_LAB_TLS_DIR),
  };
}

/**
 * Starts every site. With a TLS directory (lab.crt and lab.key) the sites a bot opens are HTTPS, as
 * real portals are; the token-gated control port stays plain HTTP for the runner.
 */
export function startSites(lab: Lab, hostname: string, tlsDir?: string) {
  const tls = tlsDir
    ? {
        cert: readFileSync(path.join(tlsDir, "lab.crt")),
        key: readFileSync(path.join(tlsDir, "lab.key")),
      }
    : undefined;
  return buildSites(lab).map((s) => {
    const secure = Boolean(tls) && s.port !== lab.ports.control;
    const server = serve({
      fetch: s.app.fetch,
      port: s.port,
      hostname,
      ...(secure ? { createServer, serverOptions: tls } : {}),
    });
    return { ...s, secure, server };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = optionsFromEnv();
  // The control port exposes one-time codes; a bot that can reach it can read them. Never serve it open.
  if (!options.token && process.env.HARNESS_LAB_ALLOW_OPEN !== "1") {
    console.error(
      "HARNESS_LAB_TOKEN is required (set HARNESS_LAB_ALLOW_OPEN=1 only for local debugging)",
    );
    process.exit(1);
  }
  const lab = new Lab(options);
  const hostname = process.env.HARNESS_LAB_BIND ?? "127.0.0.1";
  for (const s of startSites(lab, hostname, process.env.HARNESS_LAB_TLS_DIR)) {
    console.log(`${s.name.padEnd(36)} ${s.secure ? "https" : "http"}://${hostname}:${s.port}`);
  }
}
