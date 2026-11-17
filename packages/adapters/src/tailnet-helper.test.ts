import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TAILNET_CONNECT_PATH, tailnetDestinationKey } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKGROUND_WORK_LAUNCH } from "./computer-idle.js";
import { tailnetHelper } from "./page-browser-install.js";
import type { TailnetTunnelDeps } from "./tailnet-tunnel.js";
import {
  sealComputerTailnetPass,
  sealTailnetTunnelToken,
  TailnetTunnelGateway,
  tailnetTunnelKey,
} from "./tailnet-tunnel.js";

/** The computer's helper, run against the real gateway over loopback. */
const HELPER = fileURLToPath(
  new URL("../../../infra/sandboxes/computer/rakazo-net", import.meta.url),
);
const KEY = tailnetTunnelKey("test-only-encryption-key");
const RUN = {
  userId: "alice",
  spaceId: "home",
  botId: "helper",
  botName: "Helper",
  threadId: "thread1",
};
const run = promisify(execFile);

let gatewayServer: Server;
let echo: NetServer;
/** Greets, ends its own sending at once, then reports what it still heard. */
let greeter: NetServer;
let heardAfterGreeting = deferred<string>();
let web: Server;
let gatewayPort = 0;
let refuse: string | undefined;
const children: ChildProcess[] = [];

/** Fake tailnet: names on the far side of the tunnel, served by local servers. */
const services = new Map<string, () => number>();

function port(server: { address(): AddressInfo | string | null }): number {
  return (server.address() as AddressInfo).port;
}

function environment(token?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    RAKAZO_NET_URL: `http://127.0.0.1:${gatewayPort}${TAILNET_CONNECT_PATH}`,
    RAKAZO_NET_TOKEN:
      token ??
      sealTailnetTunnelToken(
        {
          runId: "run1",
          userId: "alice",
          spaceId: "home",
          botId: "helper",
          expiresAt: Date.now() + 60_000,
        },
        KEY,
      ),
  };
}

function helper(args: string[], input?: string, token?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      "python3",
      [HELPER, ...args],
      { env: environment(token), timeout: 15_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

beforeAll(async () => {
  // Echoes, then ends once the client has ended: answering only after a half-close.
  echo = createNetServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat(chunks)));
  });
  greeter = createNetServer({ allowHalfOpen: true }, (socket) => {
    let heard = "";
    socket.on("data", (chunk) => {
      heard += chunk;
    });
    socket.on("end", () => {
      heardAfterGreeting.resolve(heard);
      socket.destroy();
    });
    socket.end("hi\n");
  });
  // Fixed bodies for the paths these tests hit — never echo request.url into the response.
  const pages: Record<string, string> = {
    "/hi?x=1": "tailnet web /hi?x=1",
    "/page": "tailnet web /page",
  };
  web = createServer((request, response) =>
    response.writeHead(200, { "content-type": "text/plain" }).end(pages[request.url ?? ""] ?? ""),
  );
  await Promise.all([
    new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => greeter.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve)),
  ]);
  services.set("nas.tail1234.ts.net:7", () => port(echo));
  services.set("nas.tail1234.ts.net:9", () => port(greeter));
  services.set("web.tail1234.ts.net:80", () => port(web));
  const deps: TailnetTunnelDeps = {
    key: KEY,
    activeRun: async (claims) => (claims.runId === "run1" ? RUN : undefined),
    // The member holds control of the helper bot's screen on computer1.
    screen: async (pass, botId) =>
      pass.computerId === "computer1" && botId === "helper"
        ? { kind: "member", member: { userId: "alice", spaceId: "home", botId, botName: "Helper" } }
        : undefined,
    allowed: async () => true,
    authorize: async () => refuse ?? true,
    dial: async (_run, destination) => {
      const local = services.get(tailnetDestinationKey(destination));
      if (!local) throw new Error("unknown service");
      // Half-open, as a node's connection is.
      const socket = connect({ port: local(), host: "127.0.0.1", allowHalfOpen: true });
      await once(socket, "connect");
      return socket;
    },
  };
  const gateway = new TailnetTunnelGateway(deps);
  gatewayServer = createServer();
  gatewayServer.on("upgrade", gateway.handleUpgrade);
  await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
  gatewayPort = port(gatewayServer);
});

afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(
    [gatewayServer, echo, greeter, web].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
});

describe("rakazo-net", () => {
  it("connects stdin and stdout to a tailnet host, with a half-close", async () => {
    const result = await helper(["nc", "nas.tail1234.ts.net", "7"], "hello over the tailnet");
    expect(result).toMatchObject({ code: 0, stdout: "hello over the tailnet" });
  });

  it("keeps sending to a host that has finished sending", async () => {
    heardAfterGreeting = deferred<string>();
    const child = spawn("python3", [HELPER, "nc", "nas.tail1234.ts.net", "9"], {
      env: environment(),
    });
    children.push(child);
    child.stdout.setEncoding("utf8");
    let output = "";
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("hi")) resolve();
      });
    });
    // The host has ended its side by now; the reply still reaches it.
    child.stdin.end("late reply");
    expect(await heardAfterGreeting.promise).toBe("late reply");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(output).toBe("hi\n");
  });

  it("prints Rakazo's reason when a connection is refused", async () => {
    refuse = "Ask to connect to nas.tail1234.ts.net:7 first.";
    try {
      const result = await helper(["nc", "nas.tail1234.ts.net", "7"], "");
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("rakazo-net: Ask to connect to nas.tail1234.ts.net:7 first.\n");
    } finally {
      refuse = undefined;
    }
  });

  it("says when the command's access has ended", async () => {
    const expired = sealTailnetTunnelToken(
      {
        runId: "run1",
        userId: "alice",
        spaceId: "home",
        botId: "helper",
        expiresAt: Date.now() - 1,
      },
      KEY,
    );
    const result = await helper(["nc", "nas.tail1234.ts.net", "7"], "", expired);
    expect(result.stderr).toContain("This command's tailnet access has ended.");
  });

  it("runs a command whose HTTP to tailnet hosts goes through the tunnel", async () => {
    const script =
      "import urllib.request; print(urllib.request.urlopen('http://web.tail1234.ts.net/hi?x=1').read().decode())";
    const result = await helper(["run", "python3", "-I", "-c", script]);
    expect(result).toMatchObject({ code: 0, stdout: "tailnet web /hi?x=1\n" });
  });

  it("tunnels CONNECT through the command's proxy", async () => {
    const script = [
      "import os, socket, urllib.parse",
      "proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])",
      "s = socket.create_connection((proxy.hostname, proxy.port))",
      "s.sendall(b'CONNECT nas.tail1234.ts.net:7 HTTP/1.1\\r\\nHost: nas.tail1234.ts.net:7\\r\\n\\r\\n')",
      "head = b''",
      "while b'\\r\\n\\r\\n' not in head: head += s.recv(1)",
      "assert head.startswith(b'HTTP/1.1 200'), head",
      "s.sendall(b'via connect'); s.shutdown(socket.SHUT_WR)",
      "data = b''",
      "while True:",
      "    chunk = s.recv(4096)",
      "    if not chunk: break",
      "    data += chunk",
      "print(data.decode())",
    ].join("\n");
    const result = await helper(["run", "python3", "-I", "-c", script]);
    expect(result).toMatchObject({ code: 0, stdout: "via connect\n" });
  });

  it("returns the command's exit status", async () => {
    const result = await helper(["run", "python3", "-I", "-c", "raise SystemExit(3)"]);
    expect(result.code).toBe(3);
  });

  it("forwards a local port to a tailnet host", async () => {
    const free = createNetServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const local = port(free);
    await new Promise((resolve) => free.close(resolve));
    const child = spawn("python3", [HELPER, "forward", String(local), "nas.tail1234.ts.net:7"], {
      env: environment(),
    });
    children.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    await new Promise<void>((resolve) =>
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes("Forwarding")) resolve();
      }),
    );
    expect(stderr).toBe(`Forwarding 127.0.0.1:${local} to nas.tail1234.ts.net:7\n`);
    const socket = connect(local, "127.0.0.1");
    await once(socket, "connect");
    socket.end("forwarded");
    let reply = "";
    for await (const chunk of socket) reply += chunk;
    expect(reply).toBe("forwarded");
    child.kill();
  });

  it("refuses to forward to a host off the tailnet", async () => {
    const result = await helper(["forward", "15432", "example.com:5432"]);
    expect(result).toMatchObject({
      code: 1,
      stderr: "rakazo-net: example.com is not a tailnet host.\n",
    });
  });

  it("never sends its token unencrypted off this machine", async () => {
    const { stderr } = await run("python3", [HELPER, "nc", "nas.tail1234.ts.net", "7"], {
      env: {
        ...environment(),
        RAKAZO_NET_URL: `http://rakazo.example.test${TAILNET_CONNECT_PATH}`,
      },
    }).catch((error: { stderr: string }) => error);
    expect(stderr).toBe("rakazo-net: RAKAZO_NET_URL must use https.\n");
  });

  it("explains a secure connection that fails, without a traceback", async () => {
    // The gateway here speaks plain HTTP, so the TLS handshake fails.
    const { stderr } = await run("python3", [HELPER, "nc", "nas.tail1234.ts.net", "7"], {
      env: {
        ...environment(),
        RAKAZO_NET_URL: `https://127.0.0.1:${gatewayPort}${TAILNET_CONNECT_PATH}`,
      },
    }).catch((error: { stderr: string }) => error);
    expect(stderr).toMatch(/^rakazo-net: Rakazo could not be reached securely: /);
    expect(stderr).not.toContain("Traceback");
  });

  it("is off without Rakazo's tunnel settings", async () => {
    const { stderr } = await run("python3", [HELPER, "nc", "nas.tail1234.ts.net", "7"], {
      env: { PATH: process.env.PATH },
    }).catch((error: { stderr: string }) => error);
    expect(stderr).toBe("rakazo-net: Tailnet access is off for this bot.\n");
  });
});

describe("rakazo-net's proxy for a computer's browsers", () => {
  /**
   * The proxy serves every screen from fixed paths under /tmp/rakazo; here they point into a
   * temporary folder, and the proxy for display 7 listens on a free port.
   */
  async function screens(bot: string) {
    const dir = await mkdtemp(join(tmpdir(), "rkz-screens-"));
    const free = createNetServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const proxyPort = port(free);
    await new Promise((resolve) => free.close(resolve));
    await writeFile(join(dir, "screen-bot-7"), bot);
    await writeFile(
      join(dir, "pass.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${gatewayPort}${TAILNET_CONNECT_PATH}`,
        pass: sealComputerTailnetPass({ computerId: "computer1", boot: "boot1" }, KEY),
      }),
    );
    const serve = [
      "import importlib.machinery, os, sys",
      `net = importlib.machinery.SourceFileLoader("rakazo_net", ${JSON.stringify(HELPER)}).load_module()`,
      `net.SCREEN_BOT_FILE = os.path.join(${JSON.stringify(dir)}, "screen-bot-{}")`,
      `net.SCREEN_PASS = os.path.join(${JSON.stringify(dir)}, "pass.json")`,
      `net.SCREEN_PORT_BASE = ${proxyPort - 7}`,
      "net.SCREEN_SCAN_SECONDS = 0.05",
      "net.command_screens_serve()",
    ].join("\n");
    const child = spawn("python3", ["-c", serve], { env: { PATH: process.env.PATH } });
    children.push(child);
    await vi.waitFor(
      async () => {
        const probe = connect(proxyPort, "127.0.0.1");
        try {
          await once(probe, "connect");
        } finally {
          probe.destroy();
        }
      },
      { timeout: 5_000, interval: 50 },
    );
    /** One HTTP request to the proxy, as a browser sends it, and the whole reply. */
    const request = async (head: string, body = "") => {
      const socket = connect(proxyPort, "127.0.0.1");
      await once(socket, "connect");
      socket.write(head + body);
      if (body) socket.end();
      let reply = "";
      socket.setEncoding("utf8");
      for await (const chunk of socket) reply += chunk;
      return reply;
    };
    return {
      request,
      async close() {
        child.kill();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  it("carries a browser's tailnet requests as the screen's bot, for whoever uses it", async () => {
    const proxy = await screens("helper");
    try {
      const page = await proxy.request(
        "GET http://web.tail1234.ts.net/page HTTP/1.1\r\nHost: web.tail1234.ts.net\r\n\r\n",
      );
      expect(page).toContain("tailnet web /page");
      const tunnelled = await proxy.request(
        "CONNECT nas.tail1234.ts.net:7 HTTP/1.1\r\nHost: nas.tail1234.ts.net:7\r\n\r\n",
        "via the browser",
      );
      expect(tunnelled).toBe("HTTP/1.1 200 Connection Established\r\n\r\nvia the browser");
    } finally {
      await proxy.close();
    }
  });

  it("refuses hosts off the tailnet, and screens nobody may use", async () => {
    const proxy = await screens("helper");
    try {
      const off = await proxy.request(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
      );
      expect(off).toContain("403 Forbidden");
      expect(off).toContain("Only tailnet hosts go through this proxy.");
    } finally {
      await proxy.close();
    }
    const elsewhere = await screens("another-bot");
    try {
      const refused = await elsewhere.request(
        "CONNECT nas.tail1234.ts.net:7 HTTP/1.1\r\nHost: nas.tail1234.ts.net:7\r\n\r\n",
      );
      expect(refused).toContain("403 Forbidden");
      expect(refused).toContain("while its bot is working, or while you control its screen");
    } finally {
      await elsewhere.close();
    }
  });
});

describe("the shell launcher", () => {
  it("installs rakazo-net from a command's tunnel settings and puts it on PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "rkz-home-"));
    try {
      const helper = tailnetHelper();
      const launch = (command: string, extra: NodeJS.ProcessEnv) =>
        run(
          "bash",
          [
            "-c",
            BACKGROUND_WORK_LAUNCH,
            "rakazo-background-launch",
            "computer",
            "run",
            randomUUID(),
            command,
          ],
          { env: { PATH: process.env.PATH, HOME: home, ...extra } },
        );
      const settings = {
        ...environment(),
        RAKAZO_NET_HELPER: helper.base64,
        RAKAZO_NET_VERSION: helper.version,
      };
      const found = await launch(
        'command -v rakazo-net; [ -z "$RAKAZO_NET_HELPER" ] && echo hidden',
        settings,
      );
      const installedAt = join(home, ".cache/rakazo/net", helper.version, "rakazo-net");
      expect(found.stdout).toBe(`${installedAt}\nhidden\n`);
      const installed = await readFile(installedAt, "utf8");
      expect(installed).toBe(await readFile(HELPER, "utf8"));
      // The installed helper reaches the tailnet through the same command settings.
      const reply = await launch("printf hello | rakazo-net nc nas.tail1234.ts.net 7", settings);
      expect(reply.stdout).toBe("hello");
      // A command without tunnel settings neither gets nor needs it.
      const plain = await launch("echo plain", { PATH: process.env.PATH });
      expect(plain.stdout).toBe("plain\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
