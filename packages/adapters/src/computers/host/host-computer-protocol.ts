import { boundedSandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import { z } from "zod";
import { hostScreenMethods } from "../screens/host-screen.js";

export const HOST_COMPUTER_MAX_BYTES = 12 * 1024 * 1024;
export const HOST_COMPUTER_MAX_FILE_BYTES = 8 * 1024 * 1024;
const file = z.object({
  path: z.string().max(4096),
  content: z.string().max(HOST_COMPUTER_MAX_BYTES),
  executable: z.boolean().optional(),
});
const command = z.object({
  argv: z
    .array(z.string().max(1024 * 1024))
    .min(1)
    .max(1024),
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  unsetEnv: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const directories = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ensure"), paths: z.array(z.string().max(4096)).max(256) }),
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("remove"),
    parent: z.enum(["bots", ".browser-profiles"]),
    names: z.array(z.string().max(256)).max(256),
  }),
]);
const base = { botId: z.string().min(1).max(256), runId: z.string().min(1).max(256).optional() };
export const hostComputerRequest = z.discriminatedUnion("method", [
  z.object({
    ...base,
    method: z.enum([
      "provision",
      "prepare",
      "isRunning",
      "exportWorkspace",
      "snapshot",
      "stop",
      "destroy",
      "environment",
    ]),
  }),
  z.object({ ...base, method: z.literal("execute"), command }),
  z.object({ ...base, method: z.literal("workspaceDirectories"), directories }),
  z.object({
    ...base,
    method: z.literal("cancelRunWork"),
    targetRunId: z.string().min(1).max(256),
  }),
  z.object({ ...base, method: z.literal("listFiles"), path: z.string().max(4096) }),
  z.object({
    ...base,
    method: z.literal("readFile"),
    path: z.string().max(4096),
    maxBytes: z.number().int().positive().max(HOST_COMPUTER_MAX_FILE_BYTES).optional(),
  }),
  z.object({ ...base, method: z.literal("writeFile"), file }),
  z.object({ ...base, method: z.literal("screenObserve"), ...hostScreenMethods.screenObserve }),
  z.object({ ...base, method: z.literal("screenAct"), ...hostScreenMethods.screenAct }),
]);
export type HostComputerRequest = z.infer<typeof hostComputerRequest>;
export interface HostComputerEnvironment {
  platform: string;
  home: string;
  shell: string;
}
export type HostComputerFrame<T> =
  | { value: T }
  | { done: true }
  | { error: string }
  | { heartbeat: true };

/**
 * The text of the error frame for a file over the size limit. Desktop apps already installed
 * send and read exactly this, so it is the wire format.
 */
export function hostComputerFileTooLargeMessage(maxBytes: number) {
  return `computer file exceeds ${maxBytes} bytes`;
}
/** The limit in a file-too-large error frame, or undefined for any other error frame. */
export function hostComputerFileTooLargeLimit(message: string): number | undefined {
  const limit = /^computer file exceeds (\d+) bytes$/.exec(message)?.[1];
  return limit === undefined ? undefined : Number(limit);
}

/** Leave time for the command timeout event and final response to cross the bridge. */
export function hostComputerDeadlineMs(request: HostComputerRequest) {
  if (request.method === "execute")
    return boundedSandboxCommandTimeoutMs(request.command.timeoutMs) + 30_000;
  return request.method.startsWith("screen") ? 2 * 60_000 : 10 * 60_000;
}
