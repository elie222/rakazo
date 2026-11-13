import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { duplexPair } from "node:stream";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { TAILNET_CONNECT_PATH } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { TailnetTunnelDeps, TailnetTunnelRecord } from "./tailnet-tunnel.js";
import {
  createTailnetApprovals,
  createTailnetCommandAccess,
  openTailnetTunnelToken,
  sealTailnetTunnelToken,
  TailnetTunnelGateway,
  tailnetServerOrigin,
  tailnetTunnelKey,
} from "./tailnet-tunnel.js";

const KEY = tailnetTunnelKey("test-only-encryption-key");
const CLAIMS = {
  runId: "run1",
  userId: "alice",
  spaceId: "home",
  botId: "helper",
  expiresAt: Date.now() + 60_000,
};
const RUN = {
  userId: "alice",
  spaceId: "home",
  botId: "helper",
  botName: "Helper",
  threadId: "thread1",
};

let server: Server | undefined;

async function gateway(overrides: Partial<TailnetTunnelDeps> = {}) {
  const records: TailnetTunnelRecord[] = [];
  const gateway = new TailnetTunnelGateway({
    key: KEY,
    activeRun: async (claims) => (claims.runId === "run1" ? RUN : undefined),
    authorize: async () => true,
    // An echo service on the far side of the tailnet.
    dial: async () => {
      const [client, service] = duplexPair();
      service.on("data", (chunk) => service.write(chunk));
      service.on("end", () => service.end());
      return client;
    },
    record: (record) => records.push(record),
    ...overrides,
  });
  server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (gateway.matches(request)) gateway.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const connect = (options: { token?: string; host?: string; port?: string } = {}) => {
    const query = new URLSearchParams({
      host: options.host ?? "nas.tail1234.ts.net",
      port: options.port ?? "22",
    });
    return new WebSocket(`ws://127.0.0.1:${port}${TAILNET_CONNECT_PATH}?${query}`, {
      headers: {
        authorization: `Bearer ${options.token ?? sealTailnetTunnelToken(CLAIMS, KEY)}`,
      },
    });
  };
  return { gateway, records, connect };
}

/** The refusal a client sees before any upgrade: status and the reason in the body. */
async function refusal(socket: WebSocket): Promise<{ status: number; body: string }> {
  const [, response] = (await once(socket, "unexpected-response")) as [unknown, IncomingMessage];
  let body = "";
  for await (const chunk of response) body += chunk;
  return { status: response.statusCode ?? 0, body: body.trim() };
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("tailnet tunnel tokens", () => {
  it("round-trips and refuses tampering, other keys and expiry", () => {
    const token = sealTailnetTunnelToken(CLAIMS, KEY);
    expect(openTailnetTunnelToken(token, KEY)).toEqual(CLAIMS);
    const [prefix, payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(["run1", "bob", "home", "helper", CLAIMS.expiresAt]),
    ).toString("base64url");
    expect(openTailnetTunnelToken(`${prefix}.${forged}.${mac}`, KEY)).toBeUndefined();
    expect(openTailnetTunnelToken(token, tailnetTunnelKey("another-key"))).toBeUndefined();
    expect(openTailnetTunnelToken(token, KEY, CLAIMS.expiresAt)).toBeUndefined();
    expect(openTailnetTunnelToken(`${prefix}.${payload}`, KEY)).toBeUndefined();
    expect(openTailnetTunnelToken("not a token", KEY)).toBeUndefined();
  });
});

describe("TailnetTunnelGateway", () => {
  it("carries a TCP stream both ways and records it", async () => {
    const { connect, records } = await gateway();
    const socket = connect();
    await once(socket, "open");
    socket.send(Buffer.from("ping"));
    const [reply] = await once(socket, "message");
    expect(String(reply)).toBe("ping");
    socket.close();
    await once(socket, "close");
    await expect.poll(() => records.length).toBe(1);
    expect(records[0]).toMatchObject({
      outcome: "closed",
      destination: { host: "nas.tail1234.ts.net", port: 22 },
      bytesSent: 4,
      bytesReceived: 4,
      run: { ...RUN, runId: "run1" },
    });
  });

  it("relays a server that speaks first over a connection handed over paused", async () => {
    const { connect } = await gateway({
      // As a real node dials: paused, with SSH's banner already waiting.
      dial: async () => {
        const [client, service] = duplexPair();
        service.write("SSH-2.0-OpenSSH_test\r\n");
        return client.pause();
      },
    });
    const socket = connect();
    const [banner] = await once(socket, "message");
    expect(String(banner)).toBe("SSH-2.0-OpenSSH_test\r\n");
    socket.close();
  });

  it("refuses a missing, forged or expired token, and a run that has ended", async () => {
    const { connect } = await gateway();
    for (const token of [
      "x",
      sealTailnetTunnelToken(CLAIMS, tailnetTunnelKey("other")),
      sealTailnetTunnelToken({ ...CLAIMS, expiresAt: Date.now() - 1 }, KEY),
      sealTailnetTunnelToken({ ...CLAIMS, runId: "ended" }, KEY),
    ]) {
      expect(await refusal(connect({ token }))).toEqual({
        status: 401,
        body: "This command's tailnet access has ended. Run it again.",
      });
    }
  });

  it("refuses destinations off the tailnet before asking anything", async () => {
    let asked = false;
    const { connect } = await gateway({
      authorize: async () => {
        asked = true;
        return true;
      },
    });
    expect((await refusal(connect({ host: "example.com", port: "443" }))).status).toBe(400);
    expect((await refusal(connect({ host: "100.100.100.100", port: "53" }))).status).toBe(400);
    expect(asked).toBe(false);
  });

  it("refuses a destination the run was not approved for, with the reason", async () => {
    const { connect, records } = await gateway({
      authorize: async () => "Ask to connect to nas.tail1234.ts.net:22 first.",
    });
    expect(await refusal(connect())).toEqual({
      status: 403,
      body: "Ask to connect to nas.tail1234.ts.net:22 first.",
    });
    expect(records[0]).toMatchObject({ outcome: "refused" });
  });

  it("reports a dial that fails", async () => {
    const { connect, records } = await gateway({
      dial: async () => {
        throw new PrivateNetworkError(
          "unavailable",
          "nas.tail1234.ts.net:22: The connection was refused.",
        );
      },
    });
    expect(await refusal(connect())).toEqual({
      status: 502,
      body: "nas.tail1234.ts.net:22: The connection was refused.",
    });
    expect(records[0]).toMatchObject({ outcome: "failed" });
  });

  it("limits open tunnels per run", async () => {
    const { connect } = await gateway({ maxPerRun: 1 });
    const first = connect();
    await once(first, "open");
    expect((await refusal(connect())).status).toBe(429);
    first.close();
  });

  it("closes a run's tunnels when it ends", async () => {
    const { connect, gateway: tunnels } = await gateway();
    const socket = connect();
    await once(socket, "open");
    tunnels.closeRun("run1");
    await once(socket, "close");
  });
});

describe("tailnet settings for shell commands", () => {
  const prisma = {
    tailnetConnection: {
      findUnique: async ({ where }: { where: { spaceId_userId: { userId: string } } }) =>
        where.spaceId_userId.userId === "alice" ? { botIds: ["helper"] } : null,
    },
  } as never;
  const HOUR = 60 * 60_000;
  const access = (options: { serverOrigin?: string; available?: boolean; now?: number } = {}) =>
    createTailnetCommandAccess({
      prisma,
      encryptionKey: "test-only-encryption-key",
      serverOrigin:
        "serverOrigin" in options ? options.serverOrigin : "https://rakazo.example.test",
      available: Promise.resolve(options.available ?? true),
      now: () => options.now ?? Date.parse("2026-11-12T10:20:00Z"),
    });
  const run = { runId: "run1", userId: "alice", spaceId: "home", botId: "helper" };

  it("gives an allowed bot's run the tunnel and a token naming the run", async () => {
    const settings = await access().environment(run);
    expect(settings?.RAKAZO_NET_URL).toBe("https://rakazo.example.test/api/tailnet/connect");
    const claims = openTailnetTunnelToken(
      settings?.RAKAZO_NET_TOKEN ?? "",
      KEY,
      Date.parse("2026-11-12T10:20:00Z"),
    );
    expect(claims).toEqual({ ...run, expiresAt: Date.parse("2026-11-12T23:00:00Z") });
  });

  it("shares one token across a run's commands within the hour", async () => {
    const first = await access({ now: Date.parse("2026-11-12T10:20:00Z") }).environment(run);
    const later = await access({ now: Date.parse("2026-11-12T10:55:00Z") }).environment(run);
    expect(later?.RAKAZO_NET_TOKEN).toBe(first?.RAKAZO_NET_TOKEN);
    const next = await access({ now: Date.parse("2026-11-12T10:20:00Z") + HOUR }).environment(run);
    expect(next?.RAKAZO_NET_TOKEN).not.toBe(first?.RAKAZO_NET_TOKEN);
  });

  it("gives nothing to another member's run, another bot, or without a way in", async () => {
    expect(await access().environment({ ...run, userId: "bob" })).toBeUndefined();
    expect(await access().environment({ ...run, botId: "other" })).toBeUndefined();
    expect(await access({ serverOrigin: undefined }).environment(run)).toBeUndefined();
    expect(await access({ available: false }).environment(run)).toBeUndefined();
  });

  it("reaches the server at its public origin, never a loopback one", () => {
    expect(tailnetServerOrigin("https://rakazo.example.test/app")).toBe(
      "https://rakazo.example.test",
    );
    expect(tailnetServerOrigin("https://rakazo.tail1234.ts.net:8443")).toBe(
      "https://rakazo.tail1234.ts.net:8443",
    );
    expect(tailnetServerOrigin("http://127.0.0.1:5173")).toBeUndefined();
    expect(tailnetServerOrigin("http://localhost:5173")).toBeUndefined();
    expect(tailnetServerOrigin("not a url")).toBeUndefined();
  });
});

describe("tailnet approvals at the gateway", () => {
  const run = { ...RUN, runId: "run1" };
  const NAS = { host: "nas.tail1234.ts.net", port: 22 };
  function approvals(input: {
    rules?: Array<{ effect: string; matchKind: string; matchValue: string }>;
    approved?: Array<{ kind: string; request: unknown; runId: string; status: string }>;
  }) {
    const effects = input.approved ?? [];
    return createTailnetApprovals({
      spaceSettingOverride: { findUnique: async () => null },
      userActionApprovalRule: { findMany: async () => input.rules ?? [] },
      actionApprovalRule: { findMany: async () => [] },
      externalEffect: {
        findMany: async ({
          where,
        }: {
          where: { runId: string; kind: string; status: { in: string[] } };
        }) =>
          effects.filter(
            (effect) =>
              effect.runId === where.runId &&
              effect.kind === where.kind &&
              where.status.in.includes(effect.status),
          ),
      },
    } as never);
  }

  it("refuses a destination this run was not approved for", async () => {
    expect(await approvals({})(run, NAS)).toBe(
      "Ask to connect to nas.tail1234.ts.net:22 with tailnet_connect first.",
    );
  });

  it("allows what this run's tailnet_connect approved, and only that", async () => {
    const authorize = approvals({
      approved: [
        {
          runId: "run1",
          kind: "tailnet_connect",
          status: "completed",
          request: { host: "NAS.tail1234.ts.net", port: 22 },
        },
        {
          runId: "run1",
          kind: "tailnet_connect",
          status: "denied",
          request: { host: "db.tail1234.ts.net", port: 5432 },
        },
        {
          runId: "other",
          kind: "tailnet_connect",
          status: "completed",
          request: { host: "web.tail1234.ts.net", port: 80 },
        },
      ],
    });
    expect(await authorize(run, NAS)).toBe(true);
    expect(await authorize(run, { host: "nas.tail1234.ts.net", port: 445 })).not.toBe(true);
    expect(await authorize(run, { host: "db.tail1234.ts.net", port: 5432 })).not.toBe(true);
    expect(await authorize(run, { host: "web.tail1234.ts.net", port: 80 })).not.toBe(true);
  });

  it("follows Always allow and Block rules for the destination", async () => {
    expect(
      await approvals({
        rules: [
          { effect: "always_allow", matchKind: "site", matchValue: "nas.tail1234.ts.net:22" },
        ],
      })(run, NAS),
    ).toBe(true);
    // A rule for the host alone, as a web fetch saves, allows no port on it.
    expect(
      await approvals({
        rules: [{ effect: "always_allow", matchKind: "site", matchValue: "nas.tail1234.ts.net" }],
      })(run, NAS),
    ).not.toBe(true);
    expect(
      await approvals({
        rules: [{ effect: "deny", matchKind: "site", matchValue: "nas.tail1234.ts.net:22" }],
        approved: [{ runId: "run1", kind: "tailnet_connect", status: "completed", request: NAS }],
      })(run, NAS),
    ).toBe("Connecting to nas.tail1234.ts.net:22 is blocked in your approval settings.");
  });
});
