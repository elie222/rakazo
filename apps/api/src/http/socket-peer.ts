import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** The address on the other end of the connection, or undefined for an in-process request. */
export function socketPeer(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // In-process requests (tests, app.request) have no socket.
    return undefined;
  }
}
