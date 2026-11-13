import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Duplex } from "node:stream";
import type { AdapterContext, PrivateNetworkProvider, SecretStore } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetConnectionConfig, TailnetDestination } from "@rakazo/contracts";
import { tailnetNodeAttributes, tailnetNodeHostname } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { TailnetScope } from "./tailnet-connections.js";
import { resolveRunTailnet } from "./tailnet-connections.js";
import type { TailnetNodeHost } from "./tailscale-network.js";
import { TailscaleApi, TailscaleNetwork } from "./tailscale-network.js";
import { TailscaledNodeHost } from "./tailscaled-node-host.js";

/** A node nobody dialed through for this long leaves the tailnet; the next dial rejoins. */
const DEFAULT_IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

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
};

/**
 * Puts bots on their owners' tailnets. Each (member, Space, bot) gets its own node, joined from
 * the connection of the member whose run is dialing, never anyone else's. Nodes are ephemeral:
 * they leave after going idle, when their member disconnects or changes which bots are allowed,
 * and at shutdown.
 */
export class TailnetService {
  private readonly nodes = new Map<string, Node>();
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
    await this.api(config).verify(signal);
  }

  /** Join this run's bot to its member's tailnet, if they allowed it, and dial `destination`. */
  async dial(
    run: TailnetRun,
    destination: TailnetDestination,
    context: AdapterContext,
  ): Promise<Duplex> {
    const nodeHost = this.deps.nodeHost;
    if (!nodeHost) throw new PrivateNetworkError("unavailable", TAILNET_UNAVAILABLE_MESSAGE);
    const config = await resolveRunTailnet({
      prisma: this.deps.prisma,
      secretStore: this.deps.secretStore,
      run,
    });
    if (!config) throw new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE);
    const nodeId = tailnetNodeId(run);
    let node = this.nodes.get(nodeId);
    if (node && node.clientKey !== clientKey(config)) {
      await this.leave(node);
      node = undefined;
    }
    if (!node) {
      node = {
        nodeId,
        scope: { userId: run.userId, spaceId: run.spaceId },
        botId: run.botId,
        clientKey: clientKey(config),
        network: new TailscaleNetwork(this.api(config), nodeHost),
        lastUsed: this.now(),
      };
      this.nodes.set(nodeId, node);
    }
    node.lastUsed = this.now();
    try {
      await node.network.join(
        {
          nodeId,
          hostname: tailnetNodeHostname({ name: run.botName, id: run.botId }),
          attributes: tailnetNodeAttributes(run),
        },
        context,
      );
      return await node.network.dial(nodeId, destination, context);
    } finally {
      node.lastUsed = this.now();
    }
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
    await this.deps.nodeHost?.stopAll?.();
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
        .filter((node) => node.lastUsed <= cutoff)
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
          config = await resolveRunTailnet({
            prisma: this.deps.prisma,
            secretStore: this.deps.secretStore,
            run: { ...node.scope, botId: node.botId },
          });
        } catch {
          return; // Unknown is not revoked; the next sweep checks again.
        }
        if (!config || clientKey(config) !== node.clientKey) await this.leave(node);
      }),
    );
  }

  private async leave(node: Node): Promise<void> {
    if (this.nodes.get(node.nodeId) === node) this.nodes.delete(node.nodeId);
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
