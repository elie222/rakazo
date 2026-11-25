import * as z from "zod";
import { Id, IsoDate } from "../ids.js";

export const MOBILE_DEVICE_HEARTBEAT_MS = 30_000;

export const MobileDevicePlatformSchema = z.enum(["ios", "android"]);

export const MobileDeviceHeartbeatInputSchema = z.object({
  platform: MobileDevicePlatformSchema,
  name: z.string().trim().min(1).max(128).optional(),
});
export type MobileDeviceHeartbeatInput = z.infer<typeof MobileDeviceHeartbeatInputSchema>;

export const MobileDeviceSummarySchema = z.object({
  deviceId: Id,
  platform: MobileDevicePlatformSchema,
  name: z.string().nullable(),
  connected: z.boolean(),
  /** Allows clients to show a missed heartbeat without requesting the list again. */
  onlineUntil: IsoDate,
  /** A phone stays listed after its heartbeat goes stale, but not after its sign-in expires. */
  sessionExpiresAt: IsoDate.optional(),
});
export type MobileDeviceSummary = z.infer<typeof MobileDeviceSummarySchema>;
