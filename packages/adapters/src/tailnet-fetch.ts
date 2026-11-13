import type { Socket } from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { connect as tlsConnect } from "node:tls";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { isTailnetAddress, isTailnetHost } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { Agent } from "undici";
import type { SafeRemoteFetch } from "./remote-mcp.js";
import { dispatcherFetch } from "./undici-fetch.js";

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

/**
 * HTTP(S) to tailnet hosts through a bot's node. TLS runs end to end from here, so the node sees
 * only ciphertext for HTTPS; plain HTTP is still carried inside the tailnet's own encryption.
 */
export function createTailnetFetch(route: TailnetRoute): SafeRemoteFetch {
  const dispatcher = new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MS,
    connect: (options, callback) => {
      const https = options.protocol === "https:";
      const host = options.hostname.replace(/^\[|\]$/g, "");
      const port = Number(options.port) || (https ? 443 : 80);
      route
        .dial({ host, port }, AbortSignal.timeout(DIAL_TIMEOUT_MS))
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
    try {
      response = await dispatcherFetch(url, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      const refusal = privateNetworkRefusal(error);
      throw new Error(`Could not reach ${url.host}: ${refusal ?? reason(error)}`, {
        cause: error,
      });
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
