import { once } from "node:events";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TailscaledNodeHost } from "./tailscaled-node-host.js";

/** Stands in for tailscaled: a control socket for the CLI and a SOCKS5 proxy to `services`. */
const FAKE_TAILSCALED = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
const here = dirname(process.argv[1]);
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const log = (event) => appendFileSync(join(here, "events.log"), JSON.stringify(event) + "\\n");
const arg = (name) => process.argv.find((a) => a.startsWith("--" + name + "="))?.slice(name.length + 3);
log({ event: "start", pid: process.pid, args: process.argv.slice(2), envKeys: Object.keys(process.env) });
if (config.failStart) {
  process.stderr.write("tailscaled: cannot listen\\n");
  process.exit(1);
}
let up = false;
createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    if (!buf.includes("\\n")) return;
    const msg = JSON.parse(buf);
    if (msg.cmd === "up") {
      if (msg.key !== config.validKey) return sock.end(JSON.stringify({ error: "invalid key " + msg.key }) + "\\n");
      up = true;
      log({ event: "up", hostname: msg.hostname, flags: msg.flags });
    } else if (msg.cmd === "logout") {
      up = false;
      log({ event: "logout" });
    }
    sock.end(JSON.stringify({ ok: true }) + "\\n");
  });
}).listen(arg("socket"));
createServer((client) => {
  client.once("data", () => {
    client.write(Buffer.from([5, 0]));
    client.once("data", (req) => {
      const len = req[4];
      const host = req.subarray(5, 5 + len).toString();
      const port = req.readUInt16BE(5 + len);
      const target = up ? config.services[host + ":" + port] : undefined;
      if (!target) return client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      const upstream = connect(target, "127.0.0.1", () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
  });
}).listen(Number(arg("socks5-server").split(":")[1]), "127.0.0.1");
process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  process.exit(0);
});
`;

/** Stands in for the tailscale CLI: sends up/logout to the fake daemon's control socket. */
const FAKE_TAILSCALE = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { connect } from "node:net";
const args = process.argv.slice(2);
const socket = args.find((a) => a.startsWith("--socket=")).slice(9);
const [cmd, ...flags] = args.filter((a) => !a.startsWith("--socket="));
const msg = { cmd, flags };
if (cmd === "up") {
  msg.key = readFileSync(flags.find((f) => f.startsWith("--auth-key=file:")).slice(16), "utf8");
  msg.hostname = flags.find((f) => f.startsWith("--hostname=")).slice(11);
}
const c = connect(socket);
let buf = "";
c.on("data", (d) => (buf += d));
c.on("end", () => {
  const reply = JSON.parse(buf);
  if (reply.error) {
    process.stderr.write("backend error: " + reply.error + "\\n");
    process.exit(1);
  }
  process.exit(0);
});
c.write(JSON.stringify(msg) + "\\n");
`;

const KEY = "tskey-auth-kTEST-onetimevalue";
const NODE = { nodeId: "user1:bot1", hostname: "rakazo-helper-bot1", authKey: KEY };

type Event = { event: string; pid?: number; args?: string[]; envKeys?: string[]; flags?: string[] };

let root: string;
let runDir: string;
let echo: Server;
let host: TailscaledNodeHost;

async function configure(config: { failStart?: boolean } = {}) {
  const address = echo.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ validKey: KEY, services: { "nas.tail1234.ts.net:7": port }, ...config }),
  );
}

async function events(): Promise<Event[]> {
  const text = await readFile(join(root, "events.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}

function signal(): AbortSignal {
  return AbortSignal.timeout(10_000);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkz-"));
  runDir = join(root, "run");
  for (const [name, script] of [
    ["tailscaled", FAKE_TAILSCALED],
    ["tailscale", FAKE_TAILSCALE],
  ] as const) {
    await writeFile(join(root, `${name}.mjs`), script);
    await chmod(join(root, `${name}.mjs`), 0o755);
  }
  echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  await configure();
  host = new TailscaledNodeHost({
    tailscaled: join(root, "tailscaled.mjs"),
    tailscale: join(root, "tailscale.mjs"),
    runDir,
    startTimeoutMs: 10_000,
  });
});

afterEach(async () => {
  await host.stopAll();
  await new Promise((resolve) => echo.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe("TailscaledNodeHost", () => {
  it("starts an ephemeral, shielded userspace node without the backend's environment", async () => {
    process.env.RAKAZO_TEST_BACKEND_SECRET = "do-not-pass";
    try {
      await host.start(NODE, signal());
    } finally {
      delete process.env.RAKAZO_TEST_BACKEND_SECRET;
    }
    expect(await host.running(NODE.nodeId)).toBe(true);
    const [start, up] = await events();
    expect(start?.args).toEqual(
      expect.arrayContaining([
        "--state=mem:",
        "--tun=userspace-networking",
        "--port=0",
        "--no-logs-no-support",
      ]),
    );
    expect(start?.args?.find((arg) => arg.startsWith("--socks5-server="))).toMatch(
      /^--socks5-server=127\.0\.0\.1:\d+$/,
    );
    expect(start?.envKeys).not.toContain("RAKAZO_TEST_BACKEND_SECRET");
    expect(up?.flags).toEqual(
      expect.arrayContaining([
        "--hostname=rakazo-helper-bot1",
        "--shields-up",
        "--accept-routes=false",
        "--reset",
      ]),
    );
    expect(up?.flags?.join(" ")).not.toContain(KEY);
    // The one-use key file is gone once the node is up.
    const [dir] = await readdir(runDir);
    expect(await readdir(join(runDir, dir ?? ""))).not.toContain("auth-key");
  });

  it("dials tailnet services through the node and explains a refusal", async () => {
    await host.start(NODE, signal());
    const socket = await host.dial(NODE.nodeId, { host: "nas.tail1234.ts.net", port: 7 }, signal());
    socket.write("ping");
    // Dialed sockets come back paused for piping.
    const [reply] = await once(socket.resume(), "data");
    expect(String(reply)).toBe("ping");
    socket.destroy();

    const refused = await host
      .dial(NODE.nodeId, { host: "nas.tail1234.ts.net", port: 8 }, signal())
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PrivateNetworkError);
    expect((refused as Error).message).toBe("nas.tail1234.ts.net:8: The connection was refused.");
  });

  it("logs the node out, stops it, and drops its connections", async () => {
    await host.start(NODE, signal());
    const socket = await host.dial(NODE.nodeId, { host: "nas.tail1234.ts.net", port: 7 }, signal());
    await host.stop(NODE.nodeId, signal());
    expect(socket.destroyed).toBe(true);
    expect(await host.running(NODE.nodeId)).toBe(false);
    expect((await events()).map((entry) => entry.event)).toEqual([
      "start",
      "up",
      "logout",
      "sigterm",
    ]);
    expect(await readdir(runDir)).toEqual([]);
  });

  it("reports a refused key without echoing it and stops the process", async () => {
    const error = await host
      .start({ ...NODE, authKey: "tskey-auth-kTEST-wrongvalue" }, signal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateNetworkError);
    expect((error as Error).message).toContain("The bot could not join the tailnet.");
    expect((error as Error).message).toContain("invalid key [redacted]");
    expect(await host.running(NODE.nodeId)).toBe(false);
    expect((await events()).map((entry) => entry.event)).toEqual(["start", "sigterm"]);
  });

  it("reports a daemon that exits while starting", async () => {
    await configure({ failStart: true });
    const error = await host.start(NODE, signal()).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      "The bot could not join the tailnet. tailscaled: cannot listen",
    );
    expect(await host.running(NODE.nodeId)).toBe(false);
  });

  it("forgets a node whose process dies", async () => {
    await host.start(NODE, signal());
    const pid = (await events())[0]?.pid;
    process.kill(pid ?? 0, "SIGKILL");
    await until(async () => !(await host.running(NODE.nodeId)));
    await until(async () => (await readdir(runDir)).length === 0);
  });

  it("reports a missing tailscaled", async () => {
    const missing = new TailscaledNodeHost({
      tailscaled: join(root, "absent"),
      tailscale: join(root, "tailscale.mjs"),
      runDir,
      startTimeoutMs: 2_000,
    });
    const error = await missing.start(NODE, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateNetworkError);
    expect(await missing.running(NODE.nodeId)).toBe(false);
  });
});
