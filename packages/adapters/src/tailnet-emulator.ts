import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { duplexPair } from "node:stream";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { tailnetDestinationKey } from "@rakazo/contracts";
import type { TailnetNodeHost } from "./tailscale-network.js";

type EmulatedClient = { secret: string; scopes: string[]; tags: string[] };
type EmulatedKey = {
  id: string;
  key: string;
  tags: string[];
  attributes: Record<string, string>;
  ephemeral: boolean;
  preauthorized: boolean;
  reusable: boolean;
  expiresAt: number;
  used: boolean;
};
export type EmulatedDevice = {
  nodeId: string;
  hostname: string;
  tags: string[];
  attributes: Record<string, string>;
  ephemeral: boolean;
};

/**
 * Tailscale's OAuth token and auth-key endpoints, offline. It enforces what the real API does for
 * an OAuth client: valid credentials, the auth_keys scope, the posture scope for node attributes,
 * the client's own tags, and one-use keys.
 */
export class TailscaleApiEmulator {
  readonly clients = new Map<string, EmulatedClient>();
  readonly keys = new Map<string, EmulatedKey>();
  readonly devices = new Map<string, EmulatedDevice>();
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly tokens = new Map<string, EmulatedClient>();
  /** Answer every request with this status instead, for outage tests. */
  failWith: number | undefined;
  /** Custom posture attributes are a Premium and Enterprise feature; false is a free plan. */
  customAttributes = true;

  constructor(private readonly now: () => number = Date.now) {}

  addClient(id: string, client: EmulatedClient): void {
    this.clients.set(id, client);
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    this.requests.push({ method, path: url.pathname });
    if (url.origin !== "https://api.tailscale.com") return json(404, { message: "not found" });
    if (this.failWith) return json(this.failWith, { message: "unavailable" });
    if (method === "POST" && url.pathname === "/api/v2/oauth/token") {
      return this.token(new URLSearchParams(String(init.body ?? "")));
    }
    const client = this.tokens.get(
      new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    if (!client) return json(401, { message: "invalid token" });
    if (method === "POST" && url.pathname === "/api/v2/tailnet/-/keys") {
      return this.createKey(client, JSON.parse(String(init.body ?? "{}")));
    }
    const keyId = /^\/api\/v2\/tailnet\/-\/keys\/([^/]+)$/.exec(url.pathname)?.[1];
    if (method === "DELETE" && keyId) {
      const existing = [...this.keys.values()].find((key) => key.id === decodeURIComponent(keyId));
      if (!existing) return json(404, { message: "key not found" });
      this.keys.delete(existing.key);
      return new Response(null, { status: 200 });
    }
    return json(404, { message: "not found" });
  };

  /** Register a node with an auth key, as the control plane does when a node logs in. */
  redeem(authKey: string, node: { nodeId: string; hostname: string }): EmulatedDevice {
    const key = this.keys.get(authKey);
    if (!key || key.expiresAt <= this.now() || (key.used && !key.reusable)) {
      throw new PrivateNetworkError("credentials", "invalid auth key");
    }
    if (!key.preauthorized) throw new PrivateNetworkError("permission", "device needs approval");
    key.used = true;
    const device = {
      ...node,
      tags: key.tags,
      attributes: key.attributes,
      ephemeral: key.ephemeral,
    };
    this.devices.set(node.nodeId, device);
    return device;
  }

  /** A logged-out ephemeral node is deleted. */
  logout(nodeId: string): void {
    if (this.devices.get(nodeId)?.ephemeral) this.devices.delete(nodeId);
  }

  private token(form: URLSearchParams): Response {
    const client = this.clients.get(form.get("client_id") ?? "");
    if (
      form.get("grant_type") !== "client_credentials" ||
      !client ||
      client.secret !== form.get("client_secret")
    ) {
      return json(401, { error: "invalid_client" });
    }
    const token = `tskey-api-${randomUUID()}`;
    this.tokens.set(token, client);
    return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
  }

  private createKey(
    client: EmulatedClient,
    body: {
      capabilities?: {
        devices?: {
          create?: {
            reusable?: boolean;
            ephemeral?: boolean;
            preauthorized?: boolean;
            tags?: string[];
            nodeAttributes?: Record<string, string>;
          };
        };
      };
      expirySeconds?: number;
    },
  ): Response {
    if (!client.scopes.includes("auth_keys")) return json(403, { message: "missing scope" });
    const create = body.capabilities?.devices?.create ?? {};
    const tags = create.tags ?? [];
    if (tags.length === 0 || tags.some((tag) => !client.tags.includes(tag))) {
      return json(400, { message: "requested tags are invalid or not permitted" });
    }
    const attributes = create.nodeAttributes ?? {};
    if (
      Object.keys(attributes).length > 0 &&
      !client.scopes.includes("devices:posture_attributes")
    ) {
      return json(403, { message: "missing scope devices:posture_attributes" });
    }
    if (Object.keys(attributes).length > 0 && !this.customAttributes) {
      return json(403, { message: "custom posture attributes are not available on this plan" });
    }
    const key: EmulatedKey = {
      id: `k${randomUUID().replaceAll("-", "").slice(0, 12)}CNTRL`,
      key: `tskey-auth-${randomUUID()}`,
      tags,
      attributes,
      ephemeral: create.ephemeral ?? false,
      preauthorized: create.preauthorized ?? false,
      reusable: create.reusable ?? false,
      expiresAt: this.now() + (body.expirySeconds ?? 90 * 86400) * 1000,
      used: false,
    };
    this.keys.set(key.key, key);
    return json(200, { id: key.id, key: key.key, capabilities: body.capabilities });
  }
}

/** A tailnet service for the fake node host: it gets the server end of each connection. */
export type FakeTailnetService = (socket: Duplex, from: EmulatedDevice) => void;

/** Nodes in memory, joined through the API emulator, dialing in-process services. */
export class FakeTailnetNodeHost implements TailnetNodeHost {
  private readonly nodes = new Map<string, { device: EmulatedDevice; sockets: Set<Duplex> }>();

  constructor(
    private readonly api: TailscaleApiEmulator,
    readonly services = new Map<string, FakeTailnetService>(),
  ) {}

  /** Serve `host:port` on the fake tailnet. */
  serve(destination: TailnetDestination, service: FakeTailnetService): void {
    this.services.set(tailnetDestinationKey(destination), service);
  }

  async start(node: { nodeId: string; hostname: string; authKey: string }): Promise<void> {
    if (this.nodes.has(node.nodeId)) return;
    const device = this.api.redeem(node.authKey, {
      nodeId: node.nodeId,
      hostname: node.hostname,
    });
    this.nodes.set(node.nodeId, { device, sockets: new Set() });
  }

  async running(nodeId: string): Promise<boolean> {
    return this.nodes.has(nodeId);
  }

  async dial(nodeId: string, destination: TailnetDestination): Promise<Duplex> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new PrivateNetworkError("unavailable", "This bot is not on the tailnet.");
    const service = this.services.get(tailnetDestinationKey(destination));
    if (!service) {
      throw new PrivateNetworkError(
        "unavailable",
        `Connection to ${tailnetDestinationKey(destination)} was refused.`,
      );
    }
    const [client, server] = duplexPair();
    for (const socket of [client, server]) {
      node.sockets.add(socket);
      socket.once("close", () => node.sockets.delete(socket));
    }
    service(server, node.device);
    return client;
  }

  async stop(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.delete(nodeId);
    for (const socket of node.sockets) socket.destroy();
    this.api.logout(nodeId);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
