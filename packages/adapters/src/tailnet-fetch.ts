import type { Socket } from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { connect as tlsConnect } from "node:tls";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { ConnectionSetupError } from "@rakazo/contracts";
import { cancelResponseBody, deadlineSignal } from "@rakazo/core";
import { Agent } from "undici";
import type { SafeRemoteFetch } from "./mcp/remote-mcp.js";
import { dispatcherFetch } from "./network/undici-fetch.js";
import { isTailnetAddress, isTailnetHost } from "./tailnet-host.js";

/** Dials one TCP connection from a bot's tailnet node; bound to that bot and its run's member. */
export type TailnetRoute = {
  dial(destination: TailnetDestination, signal: AbortSignal): Promise<Duplex>;
};

const DIAL_TIMEOUT_MS = 30_000;
/** Pooled connections close soon after use, so a bot whose access was turned off keeps none. */
const KEEP_ALIVE_MS = 10_000;

/** A `*.ts.net` name or a Tailscale address, which only a tailnet node can reach. */
export function isTailnetUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isTailnetHost(host) || isTailnetAddress(host);
}

/** A tailnet endpoint, or undefined for any other address. Plain HTTP is carried by the tailnet. */
export function tailnetEndpoint(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!isTailnetUrl(url)) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionSetupError("Connector URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ConnectionSetupError("Connector URL must not contain credentials");
  }
  if (url.hash) throw new ConnectionSetupError("Connector URL must not contain a fragment");
  return url;
}

/**
 * HTTP(S) to tailnet hosts through a bot's node. TLS runs end to end from here, so the node sees
 * only ciphertext for HTTPS; plain HTTP is still carried inside the tailnet's own encryption.
 */
export function createTailnetFetch(route: TailnetRoute): SafeRemoteFetch {
  // A pooled connection serves whichever request comes next, so its dial carries no one
  // request's signal. It stops once every request waiting for a connection has gone away.
  const waiting = new Set<{ signal: AbortSignal | undefined }>();
  const dials = new Set<() => void>();
  const unwanted = () =>
    waiting.size > 0 && [...waiting].every((request) => request.signal?.aborted);
  const recheckDials = () => {
    for (const check of dials) check();
  };
  const dialSignal = (): { signal: AbortSignal; done: () => void } => {
    const cancel = new AbortController();
    const check = () => {
      if (unwanted()) cancel.abort(new Error("No request is waiting for this connection."));
    };
    dials.add(check);
    check();
    return {
      signal: deadlineSignal(DIAL_TIMEOUT_MS, cancel.signal),
      done: () => dials.delete(check),
    };
  };
  const dispatcher = new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MS,
    connect: (options, callback) => {
      const https = options.protocol === "https:";
      const host = options.hostname.replace(/^\[|\]$/g, "");
      const port = Number(options.port) || (https ? 443 : 80);
      const dialing = dialSignal();
      route
        .dial({ host, port }, dialing.signal)
        .finally(dialing.done)
        .then((socket) => {
          if (!https) return callback(null, socket as Socket);
          const secure: TLSSocket = tlsConnect({
            socket,
            servername: isIP(host) ? undefined : (options.servername ?? host),
            ALPNProtocols: ["http/1.1"],
          });
          const failed = (error: Error) => callback(error, null);
          secure.once("error", failed);
          secure.once("secureConnect", () => {
            secure.off("error", failed);
            callback(null, secure);
          });
        })
        .catch((error: Error) => callback(error, null));
    },
  });
  const tailnetFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Tailnet fetch requires a URL, not a Request");
    }
    const url = new URL(String(input));
    if (!isTailnetUrl(url)) throw new Error(`${url.hostname} is not on a tailnet`);
    let response: Response;
    const signal = init?.signal ?? undefined;
    const request = { signal };
    waiting.add(request);
    signal?.addEventListener("abort", recheckDials, { once: true });
    try {
      response = await dispatcherFetch(url, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      const refusal = privateNetworkRefusal(error);
      throw new ConnectionSetupError(`Could not reach ${url.host}: ${refusal ?? reason(error)}`, {
        cause: error,
      });
    } finally {
      waiting.delete(request);
      signal?.removeEventListener("abort", recheckDials);
    }
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBody(response);
      throw new Error("Tailnet redirects are not allowed");
    }
    return response;
  };
  const result = tailnetFetch as SafeRemoteFetch;
  result.close = () => dispatcher.close();
  return result;
}

/** Why the tailnet refused, worded for the member (access off, not on a tailnet, ...). */
function privateNetworkRefusal(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || !(error instanceof Error)) return undefined;
  if (error instanceof PrivateNetworkError) return error.message;
  return privateNetworkRefusal(error.cause, depth + 1);
}

function reason(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  if (depth < 5 && error.cause instanceof Error) return reason(error.cause, depth + 1);
  return error.message;
}
