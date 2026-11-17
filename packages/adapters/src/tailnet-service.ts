import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Duplex } from "node:stream";
import type { AdapterContext, PrivateNetworkProvider, SecretStore } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetConnectionConfig, TailnetDestination } from "@rakazo/contracts";
import { tailnetNodeAttributes, tailnetNodeHostname } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { TailnetNodeHost } from "./providers/private-network/tailscale/tailscale-network.js";
import {
  TailscaleApi,
  TailscaleNetwork,
} from "./providers/private-network/tailscale/tailscale-network.js";
import { TailscaledNodeHost } from "./providers/private-network/tailscale/tailscaled-node-host.js";
import type { TailnetScope } from "./tailnet-connections.js";
import { resolveRunTailnet, tailnetBotAllowed } from "./tailnet-connections.js";
import type { TailnetRoute } from "./tailnet-fetch.js";

/** A node with no open connection for this long leaves the tailnet; the next dial rejoins. */
const DEFAULT_IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
/** Longer than a node host's own start timeout, so the host reports a slow join itself. */
const JOIN_TIMEOUT_MS = 90_000;

export const TAILNET_UNAVAILABLE_MESSAGE = "This server can't put bots on a tailnet.";
export const TAILNET_NOT_CONNECTED_MESSAGE =
  "Tailnet access is off for this bot. Connect your tailnet and turn it on in the bot's settings.";

export type TailnetRun = { userId: string; spaceId: string; botId: string; botName: string };

type Node = {
  nodeId: string;
  scope: TailnetScope;
  botId: string;
  /** The OAuth client it joined with; a replaced client takes the node off. */
  clientKey: string;
  network: PrivateNetworkProvider;
  lastUsed: number;
  /** Connections still open through it; a node carrying any is not idle. */
  open: number;
  /** Aborted when it leaves, which also stops a join still in progress, such as minting its key. */
  stopped: AbortController;
};

/**
 * Puts bots on their owners' tailnets. Each (member, Space, bot) gets its own node, joined from
 * the connection of the member whose run is dialing, never anyone else's. Nodes are ephemeral:
 * they leave after going idle, when their member disconnects or changes which bots are allowed,
 * and at shutdown.
 */
export class TailnetService {
  private readonly nodes = new Map<string, Node>();
  /** Nodes still logging out; their process holds the old client until it is gone. */
  private readonly leaving = new Map<string, Promise<void>>();
  /** API clients of live nodes' OAuth clients; dropped with the last node that uses one. */
  private readonly apis = new Map<string, TailscaleApi>();
  private readonly sweep: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(
    private readonly deps: {
      prisma: Pick<PrismaClient, "tailnetConnection">;
      secretStore: SecretStore;
      /** Absent when this server has no tailscaled; tailnet access then reports why. */
      nodeHost: (TailnetNodeHost & { stopAll?(): Promise<void> }) | undefined;
      fetch?: (input: string, init: RequestInit) => Promise<Response>;
      now?: () => number;
      idleMs?: number;
      sweepMs?: number;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    if (deps.nodeHost && deps.sweepMs !== 0) {
      this.sweep = setInterval(() => void this.tidy(), deps.sweepMs ?? SWEEP_MS);
      this.sweep.unref();
    }
  }

  get available(): boolean {
    return Boolean(this.deps.nodeHost);
  }

  /** The OAuth client is checked by minting and revoking a short key. */
  async verify(config: TailnetConnectionConfig, signal: AbortSignal): Promise<void> {
    await new TailscaleApi(config, { fetch: this.deps.fetch, now: this.deps.now }).verify(signal);
  }

  /** Join this run's bot to its member's tailnet, if they allowed it, and dial `destination`. */
  async dial(
    run: TailnetRun,
    destination: TailnetDestination,
    context: AdapterContext,
  ): Promise<Duplex> {
    const nodeHost = this.deps.nodeHost;
    if (!nodeHost) throw new PrivateNetworkError("unavailable", TAILNET_UNAVAILABLE_MESSAGE);
    const config = await this.access(run);
    if (!config) throw new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE);
    const nodeId = tailnetNodeId(run);
    const key = clientKey(config);
    let node: Node | undefined;
    // Re-read after every wait: another dial may have replaced or joined the node meanwhile.
    for (;;) {
      // A node still leaving must be gone before this one joins, or the dial would reuse it.
      const leaving = this.leaving.get(nodeId);
      if (leaving) {
        await leaving;
        continue;
      }
      node = this.nodes.get(nodeId);
      if (node && node.clientKey !== key) {
        await this.leave(node);
        continue;
      }
      break;
    }
    if (!node) {
      node = {
        nodeId,
        scope: { userId: run.userId, spaceId: run.spaceId },
        botId: run.botId,
        clientKey: key,
        network: new TailscaleNetwork(this.api(config), nodeHost),
        lastUsed: this.now(),
        open: 0,
        stopped: new AbortController(),
      };
      this.nodes.set(nodeId, node);
    }
    node.lastUsed = this.now();
    try {
      // The join is shared by every dial for this bot, so no one caller's cancel stops it; only
      // the node leaving does.
      await node.network.join(
        {
          nodeId,
          hostname: tailnetNodeHostname({ name: run.botName, id: run.botId }),
          attributes: tailnetNodeAttributes(run),
        },
        { ...context, signal: deadlineSignal(JOIN_TIMEOUT_MS, node.stopped.signal) },
      );
      if (node.stopped.signal.aborted) {
        throw new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE);
      }
      const socket = await node.network.dial(nodeId, destination, context);
      const used = node;
      used.open += 1;
      socket.once("close", () => {
        used.open -= 1;
        used.lastUsed = this.now();
      });
      return socket;
    } finally {
      node.lastUsed = this.now();
    }
  }

  /** Whether the member still lets this bot onto their tailnet, for open connections to recheck. */
  allows(run: { userId: string; spaceId: string; botId: string }): Promise<boolean> {
    return runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
      tailnetBotAllowed(this.deps.prisma, run),
    );
  }

  /**
   * Take a member's nodes off the tailnet now: all of them in the Space, or one bot's. Called
   * when they disconnect, replace their client, or turn a bot's access off.
   */
  async disconnect(scope: TailnetScope, botId?: string): Promise<void> {
    const matching = [...this.nodes.values()].filter(
      (node) =>
        node.scope.userId === scope.userId &&
        node.scope.spaceId === scope.spaceId &&
        (botId === undefined || node.botId === botId),
    );
    await Promise.all(matching.map((node) => this.leave(node)));
  }

  async close(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    await Promise.all([...this.nodes.values()].map((node) => this.leave(node)));
    await Promise.all(this.leaving.values());
    await this.deps.nodeHost?.stopAll?.();
    this.apis.clear();
  }

  /** Visible for tests; runs on a timer otherwise. */
  async tidy(): Promise<void> {
    await Promise.all([this.leaveIdle(), this.leaveRevoked()]);
  }

  /** Visible for tests; part of `tidy`. */
  async leaveIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    await Promise.all(
      [...this.nodes.values()]
        .filter((node) => node.open === 0 && node.lastUsed <= cutoff)
        .map((node) => this.leave(node)),
    );
  }

  /**
   * Take off nodes whose member turned the bot off, disconnected or replaced the client. The
   * process that changed it does so at once; this reaches every other API and worker process.
   */
  async leaveRevoked(): Promise<void> {
    await Promise.all(
      [...this.nodes.values()].map(async (node) => {
        let config: TailnetConnectionConfig | undefined;
        try {
          config = await this.access({ ...node.scope, botId: node.botId });
        } catch (error) {
          // Unknown is not revoked: new connections check again and fail, and so does the next
          // sweep. A check that keeps failing shows here.
          getLogger().warn("tailnet access check failed; the node stays until the next check", {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!config || clientKey(config) !== node.clientKey) await this.leave(node);
      }),
    );
  }

  /**
   * The client a member's run may use, read as that member: the sweep and pooled connections run
   * outside any request, where row-level security would hide the row.
   */
  private access(run: {
    userId: string;
    spaceId: string;
    botId: string;
  }): Promise<TailnetConnectionConfig | undefined> {
    return runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
      resolveRunTailnet({ prisma: this.deps.prisma, secretStore: this.deps.secretStore, run }),
    );
  }

  private async leave(node: Node): Promise<void> {
    if (this.nodes.get(node.nodeId) === node) this.nodes.delete(node.nodeId);
    node.stopped.abort(new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE));
    const stopping = this.stop(node);
    this.leaving.set(node.nodeId, stopping);
    try {
      await stopping;
    } finally {
      if (this.leaving.get(node.nodeId) === stopping) this.leaving.delete(node.nodeId);
      const inUse = [...this.nodes.values()].some((other) => other.clientKey === node.clientKey);
      if (!inUse) this.apis.delete(node.clientKey);
    }
  }

  private async stop(node: Node): Promise<void> {
    const context: AdapterContext = {
      operationId: node.nodeId,
      traceId: node.nodeId,
      spaceId: node.scope.spaceId,
      userId: node.scope.userId,
      botId: node.botId,
      signal: AbortSignal.timeout(20_000),
    };
    await node.network.leave(node.nodeId, context).catch((error: unknown) => {
      getLogger().warn("tailnet node did not leave cleanly", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** One API client per OAuth client, so its access token is reused across bots. */
  private api(config: TailnetConnectionConfig): TailscaleApi {
    const key = clientKey(config);
    let api = this.apis.get(key);
    if (!api) {
      api = new TailscaleApi(config, { fetch: this.deps.fetch, now: this.deps.now });
      this.apis.set(key, api);
    }
    return api;
  }
}

function clientKey(config: TailnetConnectionConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([config.clientId, config.clientSecret, config.tag]))
    .digest("hex");
}

/**
 * HTTP to tailnet hosts from this run's bot device, for MCP servers on its member's tailnet.
 * Undefined without a bot or tailnet devices here. Each new connection checks again that the
 * member still lets the bot on, and the dial never carries a run's signal, as sessions outlive it.
 */
export function botTailnetRoute(
  tailnet: Pick<TailnetService, "available" | "dial"> | undefined,
  prisma: Pick<PrismaClient, "bot">,
  member: { userId: string; spaceId: string; botId?: string },
  operationId: string,
): TailnetRoute | undefined {
  const { botId, userId, spaceId } = member;
  if (!tailnet?.available || !botId) return undefined;
  return {
    async dial(destination, signal) {
      // Pooled connections dial outside the request that made them, so read as the member.
      const bot = await runAsTenant({ spaceId, userId }, () =>
        prisma.bot.findFirst({ where: { id: botId, spaceId }, select: { name: true } }),
      );
      if (!bot) throw new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE);
      return tailnet.dial({ userId, spaceId, botId, botName: bot.name }, destination, {
        operationId,
        traceId: operationId,
        spaceId,
        userId,
        botId,
        signal,
      });
    },
  };
}

/** Nodes are per member, Space and bot. */
export function tailnetNodeId(run: { userId: string; spaceId: string; botId: string }): string {
  return JSON.stringify([run.userId, run.spaceId, run.botId]);
}

/**
 * The node host for this server: `tailscaled` and `tailscale` on PATH, as the server image ships
 * them. Undefined when either is missing, such as a local checkout without Tailscale.
 */
export async function createTailscaledNodeHost(
  runDir: string,
  path = process.env.PATH ?? "",
): Promise<TailscaledNodeHost | undefined> {
  const [tailscaled, tailscale] = await Promise.all([
    findExecutable("tailscaled", path),
    findExecutable("tailscale", path),
  ]);
  if (!tailscaled || !tailscale) return undefined;
  return new TailscaledNodeHost({ tailscaled, tailscale, runDir });
}

/** Whether this machine has the binaries tailnet nodes run on. */
export async function tailscaledInstalled(path = process.env.PATH ?? ""): Promise<boolean> {
  const [tailscaled, tailscale] = await Promise.all([
    findExecutable("tailscaled", path),
    findExecutable("tailscale", path),
  ]);
  return Boolean(tailscaled && tailscale);
}

async function findExecutable(name: string, path: string): Promise<string | undefined> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}
