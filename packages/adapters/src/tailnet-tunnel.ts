import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import {
  isLoopbackHost,
  parseTailnetDestination,
  TAILNET_CONNECT_PATH,
  tailnetDestinationKey,
} from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { siteAlwaysAllowed, TAILNET_CONNECT_TOOL } from "@rakazo/core";
import { requestSite } from "@rakazo/core/egress";
import type { PrismaClient } from "@rakazo/db";
import { listApprovalRules, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { WebSocketServer } from "ws";
import { tailnetHelper } from "./page-browser-install.js";
import { PASSED_EFFECT_STATUSES } from "./run-effects.js";
import type { TailnetRun } from "./tailnet-service.js";

const TOKEN_PREFIX = "rtn1";
const DIAL_TIMEOUT_MS = 20_000;
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

/** An active run behind a token, with what the gateway needs to dial for it and record it. */
export type TailnetTunnelRun = TailnetRun & { runId: string; threadId: string };

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
};

/**
 * Serves tunnel upgrades from bots' computers. Before upgrading it checks the token, that its run
 * is still active, the destination, the run's approval for it, and dials through the bot's node;
 * a refusal is a plain HTTP response with a reason the helper prints.
 */
export class TailnetTunnelGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private readonly open = new Map<string, Set<{ close(): void }>>();
  private closed = false;

  constructor(private readonly deps: TailnetTunnelDeps) {}

  /** Whether this upgrade is a tunnel; if so the gateway owns the socket from here. */
  matches(request: IncomingMessage): boolean {
    return new URL(request.url ?? "/", "http://tunnel").pathname === TAILNET_CONNECT_PATH;
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

  /** Close every tunnel of a run, such as when it ends. */
  closeRun(runId: string): void {
    for (const tunnel of this.open.get(runId) ?? []) tunnel.close();
  }

  close(): void {
    this.closed = true;
    for (const runId of this.open.keys()) this.closeRun(runId);
    this.wss.close();
  }

  private async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const url = new URL(request.url ?? "/", "http://tunnel");
    if (this.closed) return refuse(socket, 503, "The server is shutting down.");
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const claims = token ? openTailnetTunnelToken(token, this.deps.key, now()) : undefined;
    const run = claims ? await this.deps.activeRun(claims) : undefined;
    if (!claims || !run) {
      return refuse(socket, 401, "This command's tailnet access has ended. Run it again.");
    }
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
    const runWithId = { ...run, runId: claims.runId };
    const started = now();
    const record = (
      outcome: TailnetTunnelRecord["outcome"],
      extra: Partial<TailnetTunnelRecord> = {},
    ) =>
      this.deps.record?.({
        run: runWithId,
        destination,
        outcome,
        bytesSent: 0,
        bytesReceived: 0,
        durationMs: now() - started,
        ...extra,
      });
    const open = this.open.get(claims.runId) ?? new Set<{ close(): void }>();
    if (open.size >= (this.deps.maxPerRun ?? TAILNET_TUNNELS_PER_RUN)) {
      record("refused", { reason: "Too many open tailnet connections." });
      return refuse(socket, 429, "Too many open tailnet connections. Close some and retry.");
    }
    const allowed = await this.deps.authorize(runWithId, destination);
    if (allowed !== true) {
      record("refused", { reason: allowed });
      return refuse(socket, 403, allowed);
    }
    let upstream: Duplex;
    try {
      upstream = await this.deps.dial(run, destination, {
        operationId: claims.runId,
        traceId: claims.runId,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
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
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const tunnel = { close: () => ws.terminate() };
      open.add(tunnel);
      this.open.set(claims.runId, open);
      let bytesSent = 0;
      let bytesReceived = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        open.delete(tunnel);
        if (open.size === 0 && this.open.get(claims.runId) === open) this.open.delete(claims.runId);
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
        ws.send(chunk, { binary: true });
        if (ws.bufferedAmount > SEND_HIGH_WATER) {
          upstream.pause();
          const resume = () =>
            ws.bufferedAmount > SEND_HIGH_WATER ? setTimeout(resume, 10) : upstream.resume();
          setTimeout(resume, 10);
        }
      });
      // The far side ending closes the tunnel once what it sent has gone out.
      upstream.on("end", () => ws.close(1000));
      upstream.on("error", finish);
      upstream.on("close", () => {
        if (ws.readyState === ws.OPEN) ws.close(1000);
      });
      ws.on("close", finish);
      ws.on("error", finish);
    });
  }
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

/**
 * The tunnel settings a run's shell commands get, when its member let this bot onto their
 * tailnet and the bot's computer has an address for this server. Nothing otherwise, and
 * `rakazo-net` then says tailnet access is off.
 */
export function createTailnetCommandAccess(deps: {
  prisma: Pick<PrismaClient, "tailnetConnection">;
  encryptionKey: string;
  /** This server's origin as bots' computers reach it; absent when they can't. */
  serverOrigin: string | undefined;
  /** False on a server that can't run tailnet nodes. */
  available: boolean | Promise<boolean>;
  now?: () => number;
}): TailnetCommandAccess {
  const key = tailnetTunnelKey(deps.encryptionKey);
  const url = deps.serverOrigin ? new URL(TAILNET_CONNECT_PATH, deps.serverOrigin).href : undefined;
  return {
    async environment(run) {
      if (!url || !(await deps.available)) return undefined;
      const connection = await deps.prisma.tailnetConnection.findUnique({
        where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
        select: { botIds: true },
      });
      if (!connection?.botIds.includes(run.botId)) return undefined;
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
 * The origin bots' computers use to reach this server: the public web origin, unless it is a
 * loopback address only this machine can reach.
 */
export function tailnetServerOrigin(webOrigin: string): string | undefined {
  try {
    const url = new URL(webOrigin);
    return isLoopbackHost(url.hostname) ? undefined : url.origin;
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
