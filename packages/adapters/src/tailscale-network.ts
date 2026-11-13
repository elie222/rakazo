import type { Duplex } from "node:stream";
import type { AdapterContext, PrivateNetworkProvider } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetConnectionConfig, TailnetDestination } from "@rakazo/contracts";
import { isTailnetHost } from "@rakazo/contracts";
import { combineSignals } from "./connector-safety.js";

const TAILSCALE_API = "https://api.tailscale.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh an access token this long before Tailscale's one-hour expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Long enough for a node to start and register; a key that leaks is useless soon after. */
const NODE_KEY_TTL_SECONDS = 300;
const MAX_ERROR_DETAIL_CHARS = 200;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Where nodes run: a process holding one userspace Tailscale node per bot (the tsnet sidecar),
 * outside every bot computer. It never sees the OAuth client, only one-use auth keys.
 */
export interface TailnetNodeHost {
  /** Start a node with a one-use auth key and resolve once it is connected. */
  start(
    node: { nodeId: string; hostname: string; authKey: string },
    signal: AbortSignal,
  ): Promise<void>;
  running(nodeId: string, signal: AbortSignal): Promise<boolean>;
  dial(nodeId: string, destination: TailnetDestination, signal: AbortSignal): Promise<Duplex>;
  /** Log the node out, which deletes an ephemeral node, and close its connections. */
  stop(nodeId: string, signal: AbortSignal): Promise<void>;
}

/**
 * Tailscale's control-plane API through an admin's OAuth client. It only mints one-use, ephemeral,
 * pre-approved auth keys for the client's tag; it never reads or changes anything else. It works on
 * every plan: posture attributes are added where the client and plan allow them.
 */
export class TailscaleApi {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(
    private readonly config: TailnetConnectionConfig,
    deps: { fetch?: Fetch; now?: () => number } = {},
  ) {
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
  }

  /** A one-use auth key that joins one ephemeral, pre-approved node with the client's tag. */
  /**
   * Node attributes need the devices:posture_attributes scope and a Premium or Enterprise plan.
   * Once Tailscale refuses a key with them and accepts it without, this client's keys carry none.
   */
  private attributesRefused = false;

  /** A one-use auth key that joins one ephemeral, pre-approved node with the client's tag. */
  async createNodeKey(
    input: { description: string; attributes: Record<string, string>; ttlSeconds?: number },
    signal: AbortSignal,
  ): Promise<{ id: string; key: string }> {
    const attributes = this.attributesRefused ? {} : input.attributes;
    try {
      return await this.mintKey({ ...input, attributes }, signal);
    } catch (error) {
      const refused = error instanceof PrivateNetworkError && error.code === "permission";
      if (!refused || Object.keys(attributes).length === 0) throw error;
      // A refusal for any other reason (the tag) refuses the plain key too, and reports that.
      const key = await this.mintKey({ ...input, attributes: {} }, signal);
      this.attributesRefused = true;
      return key;
    }
  }

  private async mintKey(
    input: { description: string; attributes: Record<string, string>; ttlSeconds?: number },
    signal: AbortSignal,
  ): Promise<{ id: string; key: string }> {
    const response = await this.authorized(
      "/api/v2/tailnet/-/keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: [this.config.tag],
                ...(Object.keys(input.attributes).length > 0
                  ? { nodeAttributes: input.attributes }
                  : {}),
              },
            },
          },
          expirySeconds: input.ttlSeconds ?? NODE_KEY_TTL_SECONDS,
          description: keyDescription(input.description),
        }),
      },
      signal,
    );
    const body = (await response.json().catch(() => undefined)) as
      | { id?: unknown; key?: unknown }
      | undefined;
    if (typeof body?.id !== "string" || typeof body.key !== "string" || !body.key) {
      throw new PrivateNetworkError("unavailable", "Tailscale returned an unexpected auth key.");
    }
    return { id: body.id, key: body.key };
  }

  /** Mint a short key, which proves the scope and tag, then revoke it. Attributes are optional. */
  async verify(signal: AbortSignal): Promise<void> {
    const key = await this.createNodeKey(
      { description: "rakazo check", attributes: { "custom:rakazoCheck": "1" }, ttlSeconds: 60 },
      signal,
    );
    await this.deleteKey(key.id, signal);
  }

  async deleteKey(id: string, signal: AbortSignal): Promise<void> {
    await this.authorized(
      `/api/v2/tailnet/-/keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      signal,
      { allowNotFound: true },
    );
  }

  private async authorized(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    options: { allowNotFound?: boolean } = {},
  ): Promise<Response> {
    const token = await this.accessToken(signal);
    const response = await this.send(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      signal,
    });
    if (response.ok || (options.allowNotFound && response.status === 404)) return response;
    // A revoked client or a token Tailscale stopped honoring: start over next time.
    if (response.status === 401) this.token = undefined;
    throw await this.failure(response);
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return this.token.value;
    }
    const response = await this.send("/api/v2/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
      signal,
    });
    if (!response.ok) {
      throw response.status === 400 || response.status === 401
        ? new PrivateNetworkError(
            "credentials",
            "Tailscale did not accept this OAuth client. Check its ID and secret.",
          )
        : await this.failure(response);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { access_token?: unknown; expires_in?: unknown }
      | undefined;
    if (typeof body?.access_token !== "string" || !body.access_token) {
      throw new PrivateNetworkError("unavailable", "Tailscale returned an unexpected token.");
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return body.access_token;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const signal = combineSignals(
      init.signal ?? undefined,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    try {
      return await this.fetch(`${TAILSCALE_API}${path}`, { ...init, signal, redirect: "error" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new PrivateNetworkError("unavailable", "Tailscale could not be reached.", {
        cause: error,
      });
    }
  }

  private async failure(response: Response): Promise<PrivateNetworkError> {
    const detail = await errorDetail(response, this.config.clientSecret);
    if (response.status === 401) {
      return new PrivateNetworkError(
        "credentials",
        "Tailscale did not accept this OAuth client. Check its ID and secret.",
      );
    }
    if (response.status === 400 || response.status === 403) {
      return new PrivateNetworkError(
        "permission",
        `This OAuth client can't create keys for ${this.config.tag}. Give it the auth_keys scope and that tag.${detail ? ` Tailscale said: ${detail}` : ""}`,
      );
    }
    return new PrivateNetworkError(
      "unavailable",
      `Tailscale returned HTTP ${response.status}.${detail ? ` ${detail}` : ""}`,
    );
  }
}

/** Every bot joins as its own ephemeral node tagged with the connection's tag. */
export class TailscaleNetwork implements PrivateNetworkProvider {
  private readonly joining = new Map<string, Promise<void>>();

  constructor(
    private readonly api: TailscaleApi,
    private readonly nodes: TailnetNodeHost,
  ) {}

  describe() {
    return {
      id: "tailscale",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { ephemeralNodes: true },
    };
  }

  verify(context: AdapterContext): Promise<void> {
    return this.api.verify(context.signal);
  }

  join(
    node: { nodeId: string; hostname: string; attributes: Record<string, string> },
    context: AdapterContext,
  ): Promise<void> {
    const pending = this.joining.get(node.nodeId);
    if (pending) return pending;
    const started = this.start(node, context.signal).finally(() =>
      this.joining.delete(node.nodeId),
    );
    this.joining.set(node.nodeId, started);
    return started;
  }

  async dial(
    nodeId: string,
    destination: TailnetDestination,
    context: AdapterContext,
  ): Promise<Duplex> {
    if (!isTailnetHost(destination.host)) {
      throw new PrivateNetworkError("destination", `${destination.host} is not on a tailnet.`);
    }
    return await this.nodes.dial(nodeId, destination, context.signal);
  }

  async leave(nodeId: string, context: AdapterContext): Promise<void> {
    await this.nodes.stop(nodeId, context.signal);
  }

  private async start(
    node: { nodeId: string; hostname: string; attributes: Record<string, string> },
    signal: AbortSignal,
  ): Promise<void> {
    if (await this.nodes.running(node.nodeId, signal)) return;
    const key = await this.api.createNodeKey(
      { description: `rakazo ${node.hostname}`, attributes: node.attributes },
      signal,
    );
    try {
      await this.nodes.start(
        { nodeId: node.nodeId, hostname: node.hostname, authKey: key.key },
        signal,
      );
    } catch (error) {
      // An unused key could still join a node until it expires; revoke it.
      await this.api.deleteKey(key.id, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).catch(() => {});
      throw error;
    }
  }
}

/** Tailscale allows 50 letters, digits, hyphens and spaces. */
function keyDescription(value: string): string {
  return value.replace(/[^A-Za-z0-9 -]/g, "-").slice(0, 50);
}

async function errorDetail(response: Response, secret: string): Promise<string> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {}
  return message
    .split(secret)
    .join("[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_DETAIL_CHARS);
}
