import { z } from "zod";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";

export const userDeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("revoked") }),
]);
export type UserDeviceServerMessage = z.infer<typeof userDeviceServerMessage>;

/** One HostComputerFrame per message, tagged with the request id. */
export const userDeviceClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
]);
export type UserDeviceClientMessage = z.infer<typeof userDeviceClientMessage>;

export interface UserDevice {
  deviceId: string;
  name: string;
  platform: string;
}

/** How runs reach the requesting user's connected device, from any API or worker process. */
export interface UserDeviceGateway {
  connected(userId: string): Promise<UserDevice | null>;
  /** When the oldest device still paired was paired, connected or not; null when none is. */
  pairedSince(userId: string): Promise<Date | null>;
  /**
   * Streams HostComputerFrame values for one request. Throws when the device is offline,
   * revoked, or disconnects mid-request; a command is never retried after a lost response.
   * Pass `deviceId` to keep every request of one operation on the same computer.
   */
  request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T>;
}
