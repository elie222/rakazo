import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { isLoopbackHost, TAILNET_CONNECT_PATH, tailnetDestinationKey } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { siteAlwaysAllowed, TAILNET_CONNECT_TOOL } from "@rakazo/core";
import { requestSite } from "@rakazo/core/egress";
import type { PrismaClient } from "@rakazo/db";
import { listApprovalRules, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { tailnetHelper } from "./browser/page-browser-install.js";
import { sandboxKindCapabilities } from "./computers/sandbox/sandbox-kind-capabilities.js";
import { PASSED_EFFECT_STATUSES } from "./runs/lifecycle/run-effects.js";
import { parseTailnetDestination } from "./tailnet-host.js";
import type { TailnetRun } from "./tailnet-service.js";

const TOKEN_PREFIX = "rtn1";
const PASS_PREFIX = "rcp1";
const DIAL_TIMEOUT_MS = 20_000;
/**
 * How often open tunnels check that whoever opened them still may; the rest close. Only a safety
 * net: turning access off or disconnecting takes the bot's device off at once in the process that
 * changed it, which closes its tunnels there; this reaches other processes and approval changes.
 */
const RECHECK_MS = 30_000;
/** Pause reading the far side while this much is waiting to go out to the computer. */
const SEND_HIGH_WATER = 1 << 20;
/** Open tunnels one run may hold at once. */
export const TAILNET_TUNNELS_PER_RUN = 32;

export type TailnetTunnelClaims = {
  runId: string;
  userId: string;
  spaceId: string;
  botId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** The tunnel signing key, derived from the deployment's encryption key. */
export function tailnetTunnelKey(encryptionKey: string): Buffer {
  return createHmac("sha256", encryptionKey).update("rakazo tailnet tunnel v1").digest();
}

/**
 * A token naming one run, for its shell commands to open tunnels. It is only a claim: every
 * tunnel also checks that the run is still active and that its member still allows the bot.
 */
export function sealTailnetTunnelToken(claims: TailnetTunnelClaims, key: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify([claims.runId, claims.userId, claims.spaceId, claims.botId, claims.expiresAt]),
  ).toString("base64url");
  return `${TOKEN_PREFIX}.${payload}.${signature(payload, key)}`;
}

export function openTailnetTunnelToken(
  token: string,
  key: Buffer,
  now = Date.now(),
): TailnetTunnelClaims | undefined {
  const [prefix, payload, mac, extra] = token.split(".");
  if (prefix !== TOKEN_PREFIX || !payload || !mac || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(payload, key));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const [runId, userId, spaceId, botId, expiresAt] = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown[];
    if (
      typeof runId !== "string" ||
      typeof userId !== "string" ||
      typeof spaceId !== "string" ||
      typeof botId !== "string" ||
      typeof expiresAt !== "number" ||
      expiresAt <= now
    ) {
      return undefined;
    }
    return { runId, userId, spaceId, botId, expiresAt };
  } catch {
    return undefined;
  }
}

function signature(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * A computer's pass, for its browsers' proxy. It names only the computer and the start it was
 * issued for; each tunnel decides live who is using the screen, so the pass grants nothing alone.
 */
export type ComputerTailnetPass = { computerId: string; boot: string };

export function sealComputerTailnetPass(pass: ComputerTailnetPass, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify([pass.computerId, pass.boot])).toString("base64url");
  return `${PASS_PREFIX}.${payload}.${signature(`${PASS_PREFIX}.${payload}`, key)}`;
}

export function openComputerTailnetPass(
  value: string,
  key: Buffer,
): ComputerTailnetPass | undefined {
  const [prefix, payload, mac, extra] = value.split(".");
  if (prefix !== PASS_PREFIX || !payload || !mac || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(`${PASS_PREFIX}.${payload}`, key));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const [computerId, boot] = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown[];
    if (typeof computerId !== "string" || typeof boot !== "string") return undefined;
    return { computerId, boot };
  } catch {
    return undefined;
  }
}

/** An active run behind a token, with what the gateway needs to dial for it and record it. */
export type TailnetTunnelRun = TailnetRun & { runId: string; threadId: string };

/**
 * Who a tunnel acts for: a bot's run, whose approvals apply and whose thread records it, or a
 * member holding control of a bot's screen, who is browsing for themselves.
 */
export type TailnetPrincipal =
  | { kind: "run"; run: TailnetTunnelRun }
  | { kind: "member"; member: TailnetRun };

/** One finished tunnel, for the run's activity. */
export type TailnetTunnelRecord = {
  run: TailnetTunnelRun;
  destination: TailnetDestination;
  outcome: "closed" | "refused" | "failed";
  /** Why it was refused or failed, safe to show. */
  reason?: string;
  bytesSent: number;
  bytesReceived: number;
  durationMs: number;
};

export type TailnetTunnelDeps = {
  key: Buffer;
  /** The run behind a token, if it is still active and its claims still match. */
  activeRun: (claims: TailnetTunnelClaims) => Promise<Omit<TailnetTunnelRun, "runId"> | undefined>;
  /** Who is using this bot's screen on the pass's computer right now, if anyone may. */
  screen?: (pass: ComputerTailnetPass, botId: string) => Promise<TailnetPrincipal | undefined>;
  /** Whether the member still lets this bot onto their tailnet; open tunnels close once not. */
  allowed: (identity: TailnetRun) => Promise<boolean>;
  /** Whether this run may reach this destination now. A string refuses with that reason. */
  authorize: (
    run: TailnetRun & { runId: string },
    destination: TailnetDestination,
  ) => Promise<true | string>;
  dial: (
    run: TailnetRun,
    destination: TailnetDestination,
    context: AdapterContext,
  ) => Promise<Duplex>;
  record?: (record: TailnetTunnelRecord) => void;
  now?: () => number;
  maxPerRun?: number;
  recheckMs?: number;
};

type Tunnel = { destination: TailnetDestination; close(): void };

type TunnelGroup = {
  tunnels: Set<Tunnel>;
  timer?: ReturnType<typeof setInterval>;
};

/**
 * Who opened a tunnel, how to tell later that they still may, and the group it counts in: one per
 * opener and credential, so one group's recheck never closes tunnels another credential opened.
 */
type Opened = { principal: TailnetPrincipal; current: () => Promise<boolean>; key: string };

/**
 * Serves tunnel upgrades from bots' computers. Before upgrading it checks the token, that its run
 * is still active, the destination, the run's approval for it, and dials through the bot's node;
 * a refusal is a plain HTTP response with a reason the helper prints.
 */
export class TailnetTunnelGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  /** Open tunnels by who opened them, with the check that closes them once that ends. */
  private readonly open = new Map<string, TunnelGroup>();
  /** Tunnels still being checked and dialed, which count toward the limit already. */
  private readonly opening = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: TailnetTunnelDeps) {}

  /** Whether this upgrade is a tunnel; if so the gateway owns the socket from here. */
  matches(request: IncomingMessage): boolean {
    try {
      return new URL(request.url ?? "/", "http://tunnel").pathname === TAILNET_CONNECT_PATH;
    } catch {
      return false;
    }
  }

  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const onError = (error: Error) =>
      getLogger().warn("tailnet tunnel upgrade socket error", { error: error.message });
    socket.on("error", onError);
    void this.accept(request, socket, head)
      .catch((error: unknown) => {
        getLogger().error("tailnet tunnel upgrade failed", error);
        refuse(socket, 500, "The tunnel failed.");
      })
      .finally(() => socket.off("error", onError));
  };

  close(): void {
    this.closed = true;
    for (const key of [...this.open.keys()]) this.closeGroup(key);
    this.wss.close();
  }

  private closeGroup(key: string): void {
    const group = this.open.get(key);
    if (!group) return;
    for (const tunnel of [...group.tunnels]) tunnel.close();
  }

  /** Who opens this tunnel, and how to tell later that they still may. */
  private async principal(request: IncomingMessage, url: URL): Promise<Opened | undefined> {
    const now = this.deps.now ?? Date.now;
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const pass = openComputerTailnetPass(token, this.deps.key);
    if (pass) {
      const botId = url.searchParams.get("bot") ?? "";
      const screen = this.deps.screen;
      if (!botId || !screen) return undefined;
      const principal = await screen(pass, botId);
      if (!principal) return undefined;
      const holder = groupKey(principal);
      return {
        principal,
        key: `screen:${pass.computerId}:${pass.boot}:${holder}`,
        current: async () => {
          const still = await screen(pass, botId);
          return Boolean(still && groupKey(still) === holder);
        },
      };
    }
    const claims = openTailnetTunnelToken(token, this.deps.key, now());
    const run = claims ? await this.deps.activeRun(claims) : undefined;
    if (!claims || !run) return undefined;
    const principal: TailnetPrincipal = { kind: "run", run: { ...run, runId: claims.runId } };
    return {
      principal,
      key: `token:${createHmac("sha256", this.deps.key).update(token).digest("base64url")}:${groupKey(principal)}`,
      current: async () =>
        openTailnetTunnelToken(token, this.deps.key, now()) !== undefined &&
        (await this.deps.activeRun(claims)) !== undefined,
    };
  }

  private async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const url = new URL(request.url ?? "/", "http://tunnel");
    if (this.closed) return refuse(socket, 503, "The server is shutting down.");
    // Checked before anything is dialed: a handshake ws would reject never reaches its callback.
    if (!isWebSocketHandshake(request)) return refuse(socket, 400, "Expected a WebSocket upgrade.");
    const opened = await this.principal(request, url);
    if (!opened) {
      return refuse(
        socket,
        401,
        url.searchParams.has("bot")
          ? "Tailnet access in this browser works while its bot is working, or while you control its screen."
          : "This command's tailnet access has ended. Run it again.",
      );
    }
    const { principal } = opened;
    const destination = parseTailnetDestination(
      url.searchParams.get("host") ?? "",
      url.searchParams.get("port") ?? "",
    );
    if (!destination) {
      return refuse(
        socket,
        400,
        "Only tailnet hosts (*.ts.net or 100.x addresses) can be reached.",
      );
    }
    const started = now();
    const record = (
      outcome: TailnetTunnelRecord["outcome"],
      extra: Partial<TailnetTunnelRecord> = {},
    ) => {
      if (principal.kind !== "run") return;
      this.deps.record?.({
        run: principal.run,
        destination,
        outcome,
        bytesSent: 0,
        bytesReceived: 0,
        durationMs: now() - started,
        ...extra,
      });
    };
    const { key } = opened;
    const opening = this.opening.get(key) ?? 0;
    if (
      (this.open.get(key)?.tunnels.size ?? 0) + opening >=
      (this.deps.maxPerRun ?? TAILNET_TUNNELS_PER_RUN)
    ) {
      record("refused", { reason: "Too many open tailnet connections." });
      return refuse(socket, 429, "Too many open tailnet connections. Close some and retry.");
    }
    // The slot is held while this tunnel is checked and dialed, so ones opened together count.
    this.opening.set(key, opening + 1);
    try {
      await this.connect({ request, socket, head, opened, destination, key, record });
    } finally {
      const left = (this.opening.get(key) ?? 1) - 1;
      if (left > 0) this.opening.set(key, left);
      else this.opening.delete(key);
    }
  }

  private async connect(input: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    opened: Opened;
    destination: TailnetDestination;
    key: string;
    record: (outcome: TailnetTunnelRecord["outcome"], extra?: Partial<TailnetTunnelRecord>) => void;
  }): Promise<void> {
    const { request, socket, head, opened, destination, key, record } = input;
    const { principal } = opened;
    // A member browsing for themselves needs no approval; a bot's run needs its own.
    const allowed =
      principal.kind === "run" ? await this.deps.authorize(principal.run, destination) : true;
    if (allowed !== true) {
      record("refused", { reason: allowed });
      return refuse(socket, 403, allowed);
    }
    const identity = principal.kind === "run" ? principal.run : principal.member;
    const operationId = principal.kind === "run" ? principal.run.runId : `screen-${identity.botId}`;
    let upstream: Duplex;
    try {
      upstream = await this.deps.dial(identity, destination, {
        operationId,
        traceId: operationId,
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
      });
    } catch (error) {
      const reason =
        error instanceof PrivateNetworkError ? error.message : "The tailnet connection failed.";
      record("failed", { reason });
      const status =
        error instanceof PrivateNetworkError && error.code === "permission" ? 403 : 502;
      return refuse(socket, status, reason);
    }
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    // The server began shutting down while this dialed: nothing may open after close().
    if (this.closed) {
      upstream.destroy();
      return refuse(socket, 503, "The server is shutting down.");
    }
    // Upgrading completes in this call, so the tunnel joins its group before the slot is freed,
    // and a dialed connection the upgrade didn't take is closed here.
    let upgraded = false;
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        upgraded = true;
        this.relay(ws, { key, opened, destination, upstream, record });
      });
    } finally {
      if (!upgraded) upstream.destroy();
    }
  }

  /** Carries one upgraded tunnel both ways until either side ends it. */
  private relay(
    ws: WebSocket,
    input: {
      key: string;
      opened: Opened;
      destination: TailnetDestination;
      upstream: Duplex;
      record: (
        outcome: TailnetTunnelRecord["outcome"],
        extra?: Partial<TailnetTunnelRecord>,
      ) => void;
    },
  ): void {
    const { key, opened, destination, upstream, record } = input;
    const tunnel: Tunnel = { destination, close: () => ws.terminate() };
    const group = this.join(key, opened);
    group.tunnels.add(tunnel);
    let bytesSent = 0;
    let bytesReceived = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.leave(key, group, tunnel);
      upstream.destroy();
      ws.terminate();
      record("closed", { bytesSent, bytesReceived });
    };
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return finish();
      // An empty message is the computer ending its sending side: a TCP half-close.
      if (data.length === 0) return void upstream.end();
      bytesSent += data.length;
      if (!upstream.write(data)) {
        ws.pause();
        upstream.once("drain", () => ws.resume());
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      // Each send reports once it has gone out; the one that drains the backlog resumes.
      ws.send(chunk, { binary: true }, () => {
        if (upstream.isPaused() && ws.bufferedAmount <= SEND_HIGH_WATER) upstream.resume();
      });
      if (ws.bufferedAmount > SEND_HIGH_WATER) upstream.pause();
    });
    // The far side ending its sending is passed on the same way, after what it sent; the
    // computer may still send, and the tunnel closes once both sides have ended.
    upstream.on("end", () => ws.send(Buffer.alloc(0), { binary: true }));
    upstream.on("error", finish);
    upstream.on("close", () => {
      if (ws.readyState === ws.OPEN) ws.close(1000);
    });
    ws.on("close", finish);
    ws.on("error", finish);
    // A dialed connection arrives paused (see socks5Connect), and a data listener does not
    // restart a stream paused on purpose. Without this a server that speaks first, such as
    // SSH with its banner, is never heard.
    upstream.resume();
  }

  /** The group for this principal, rechecking on a timer that it still may tunnel. */
  private join(key: string, opened: Opened): TunnelGroup {
    let group = this.open.get(key);
    if (group) return group;
    const created: TunnelGroup = { tunnels: new Set() };
    let checking = false;
    created.timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.recheck(created, opened)
        .catch((error: unknown) =>
          getLogger().warn("tailnet tunnel recheck failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          checking = false;
        });
    }, this.deps.recheckMs ?? RECHECK_MS);
    created.timer.unref?.();
    group = created;
    this.open.set(key, group);
    return group;
  }

  /**
   * Close what may no longer stay open: every tunnel once whoever opened them can't, or the
   * member stops letting the bot on; a run's tunnel once its destination is no longer approved.
   */
  private async recheck(group: TunnelGroup, opened: Opened): Promise<void> {
    const { principal } = opened;
    const identity = principal.kind === "run" ? principal.run : principal.member;
    // Only this group: by the time the check answers, a new one may hold the same key.
    if (!(await opened.current()) || !(await this.deps.allowed(identity))) {
      for (const tunnel of [...group.tunnels]) tunnel.close();
      return;
    }
    if (principal.kind !== "run") return;
    const verdicts = new Map<string, Promise<true | string>>();
    for (const tunnel of [...group.tunnels]) {
      const site = tailnetDestinationKey(tunnel.destination);
      let verdict = verdicts.get(site);
      if (!verdict) {
        verdict = this.deps.authorize(principal.run, tunnel.destination);
        verdicts.set(site, verdict);
      }
      if ((await verdict) !== true) tunnel.close();
    }
  }

  private leave(key: string, group: TunnelGroup, tunnel: Tunnel): void {
    group.tunnels.delete(tunnel);
    if (group.tunnels.size > 0 || this.open.get(key) !== group) return;
    clearInterval(group.timer);
    this.open.delete(key);
  }
}

/** Tunnels group by who opened them: one run, or one member on one bot's screen. */
function groupKey(principal: TailnetPrincipal): string {
  return principal.kind === "run"
    ? `run:${principal.run.runId}`
    : `member:${principal.member.spaceId}:${principal.member.userId}:${principal.member.botId}`;
}

/** A well-formed WebSocket upgrade, as ws accepts it; anything else it refuses unanswered. */
function isWebSocketHandshake(request: IncomingMessage): boolean {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  return (
    request.method === "GET" &&
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    typeof key === "string" &&
    /^[+/0-9A-Za-z]{22}==$/.test(key) &&
    (version === "8" || version === "13")
  );
}

function refuse(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = Buffer.from(`${message}\n`);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
  );
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** How long a command's tunnel token lasts; the run ending revokes it sooner. */
const HOUR_MS = 60 * 60_000;
const COMMAND_TOKEN_TTL_MS = 12 * HOUR_MS;
/** A computer prepared this recently is not prepared again; a restart is a new start anyway. */
const COMPUTER_PREPARED_MS = 10 * 60_000;

/**
 * Installs rakazo-net where the computer's browsers' proxy runs it, and starts that proxy with
 * this computer's pass. The values arrive in the environment, never on a command line.
 */
const SCREENS_START = [
  "set -eu",
  "helper=$(mktemp /tmp/rakazo-net.XXXXXX)",
  "trap 'rm -f \"$helper\"' EXIT",
  'printf %s "$RAKAZO_NET_HELPER" | base64 -d >"$helper"',
  'python3 -I "$helper" screens-start',
].join("\n");

/**
 * The tunnel settings a run's shell commands get, when its member let this bot onto their
 * tailnet and the bot's computer has an address for this server. Nothing otherwise, and
 * `rakazo-net` then says tailnet access is off.
 */
export function createTailnetCommandAccess(deps: {
  prisma: Pick<PrismaClient, "tailnetConnection" | "computer">;
  encryptionKey: string;
  /** This server's origin as bots' computers reach it; absent when they can't. */
  serverOrigin: string | undefined;
  /** False on a server that can't run tailnet nodes. */
  available: boolean | Promise<boolean>;
  now?: () => number;
}): TailnetCommandAccess {
  const key = tailnetTunnelKey(deps.encryptionKey);
  const url = deps.serverOrigin ? new URL(TAILNET_CONNECT_PATH, deps.serverOrigin).href : undefined;
  const now = deps.now ?? Date.now;
  const prepared = new Map<string, number>();
  const allowed = async (member: { userId: string; spaceId: string; botId: string }) => {
    if (!url || !(await deps.available)) return false;
    const connection = await deps.prisma.tailnetConnection.findUnique({
      where: { spaceId_userId: { spaceId: member.spaceId, userId: member.userId } },
      select: { botIds: true },
    });
    return Boolean(connection?.botIds.includes(member.botId));
  };
  return {
    async prepareComputer({ sandbox, computerId, computer, member, context }) {
      // A native shell has no launcher to install rakazo-net, so its browsers stay off the tailnet.
      if (sandboxKindCapabilities(computer.kind).nativeShell) return;
      if (!url || !(await allowed(member))) return;
      const row = await deps.prisma.computer.findUnique({
        where: { id: computerId },
        select: { runningSince: true },
      });
      if (!row) return;
      const boot = row.runningSince?.toISOString() ?? "";
      const cacheKey = `${computerId} ${boot}`;
      if ((prepared.get(cacheKey) ?? 0) > now()) return;
      prepared.set(cacheKey, now() + COMPUTER_PREPARED_MS);
      const helper = tailnetHelper();
      let code: number | undefined;
      let output = "";
      try {
        for await (const event of sandbox.execute(
          computer,
          {
            argv: ["bash", "-c", SCREENS_START],
            env: {
              RAKAZO_NET_URL: url,
              RAKAZO_NET_PASS: sealComputerTailnetPass({ computerId, boot }, key),
              RAKAZO_NET_HELPER: helper.base64,
            },
            timeoutMs: 30_000,
          },
          context,
        )) {
          if (event.type === "exit") code = event.code;
          else output = `${output}${event.data}`.slice(-2_000);
        }
      } finally {
        if (code !== 0) prepared.delete(cacheKey);
      }
      if (code !== 0) {
        getLogger().warn("tailnet browser proxy did not start", { code, output: output.trim() });
      }
    },
    async environment(run) {
      if (!url || !(await allowed(run))) return undefined;
      // Rounded up to the hour, so a run's commands share a token and its redaction.
      const expiresAt =
        Math.ceil(((deps.now ?? Date.now)() + COMMAND_TOKEN_TTL_MS) / HOUR_MS) * HOUR_MS;
      const token = sealTailnetTunnelToken({ ...run, expiresAt }, key);
      const helper = tailnetHelper();
      return {
        RAKAZO_NET_URL: url,
        RAKAZO_NET_TOKEN: token,
        RAKAZO_NET_HELPER: helper.base64,
        RAKAZO_NET_VERSION: helper.version,
      };
    },
  };
}

export interface TailnetCommandAccess {
  /**
   * Give a computer's browsers their tailnet proxy, when this member let this bot on. The proxy
   * carries the computer's pass; each connection is decided by who uses the screen then.
   */
  prepareComputer(input: {
    sandbox: Pick<SandboxProvider, "execute">;
    computerId: string;
    computer: ComputerRef;
    member: { userId: string; spaceId: string; botId: string };
    context: AdapterContext;
  }): Promise<void>;
  environment(run: { runId: string; userId: string; spaceId: string; botId: string }): Promise<
    | {
        RAKAZO_NET_URL: string;
        RAKAZO_NET_TOKEN: string;
        /** rakazo-net itself, base64, which the shell launcher installs (see computer-idle). */
        RAKAZO_NET_HELPER: string;
        RAKAZO_NET_VERSION: string;
      }
    | undefined
  >;
}

/**
 * The origin bots' computers use to reach this server: the public web origin, when it is HTTPS,
 * so tunnel tokens never travel unencrypted, and not a loopback address only this machine can
 * reach.
 */
export function tailnetServerOrigin(webOrigin: string): string | undefined {
  try {
    const url = new URL(webOrigin);
    return url.protocol === "https:" && !isLoopbackHost(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a run may reach a tailnet destination now, decided as the tool gate decides it: a
 * Block rule refuses it, an Always allow rule allows it, and otherwise the run must have had
 * tailnet_connect for that exact destination approved.
 */
export function createTailnetApprovals(prisma: PrismaClient): TailnetTunnelDeps["authorize"] {
  return (run, destination) =>
    runAsTenant({ spaceId: run.spaceId, userId: run.userId }, async () => {
      const site = tailnetDestinationKey(destination);
      const rules = (await listApprovalRules(prisma, {
        userId: run.userId,
        spaceId: run.spaceId,
      })) as ActionApprovalRule[];
      const blocked = rules.some(
        (rule) =>
          rule.effect === "deny" &&
          rule.matchKind === "site" &&
          rule.matchValue.toLowerCase() === site,
      );
      if (blocked) return `Connecting to ${site} is blocked in your approval settings.`;
      if (siteAlwaysAllowed(rules, site)) return true;
      const approved = await prisma.externalEffect.findMany({
        where: {
          runId: run.runId,
          kind: TAILNET_CONNECT_TOOL,
          status: { in: PASSED_EFFECT_STATUSES },
        },
        select: { request: true },
      });
      return approved.some((effect) => requestSite(TAILNET_CONNECT_TOOL, effect.request) === site)
        ? true
        : `Ask to connect to ${site} with tailnet_connect first.`;
    });
}
