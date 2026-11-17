import { oc } from "@orpc/contract";
import { z } from "zod";
import { HostComputerCallSchema } from "./host-computer-tools.js";
import { Id } from "./ids.js";

const Key = z.string().min(1).max(256);
export const HostEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(262144) }),
  z.object({
    type: z.literal("operation"),
    id: Key,
    name: Key,
    status: z.enum(["running", "completed", "failed"]),
    detail: z.string().max(16384).optional(),
  }),
  z.object({ type: z.literal("session"), session: z.object({ id: Key, engineVersion: Key }) }),
  z.object({
    type: z.literal("interaction"),
    request: z.object({
      id: Key,
      kind: z.enum(["permission", "question"]),
      title: z.string().max(16384),
      detail: z.string().max(32768).optional(),
      actions: z.array(z.object({ id: Key, label: z.string().max(1000) })).max(50),
    }),
  }),
  z.object({
    type: z.literal("interaction_closed"),
    id: Key,
    status: z.enum(["delivered", "expired"]),
  }),
  z.object({
    type: z.literal("usage"),
    scope: z.enum(["run", "session"]).optional(),
    inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.object({ type: z.literal("completed") }),
  z.object({ type: z.literal("cancelled") }),
  z.object({ type: z.literal("failed"), code: Key }),
]);
export type HostEvent = z.infer<typeof HostEventSchema>;
export const HostFrameSchema = z.object({
  sequence: z.number().int().positive(),
  event: HostEventSchema,
});
export type HostFrame = z.infer<typeof HostFrameSchema>;
export const HostGrantSchema = z.object({ runId: Id, token: z.string().min(32).max(256) });
export type HostGrant = z.infer<typeof HostGrantSchema>;
export const HostStartSchema = z.object({
  botId: Id,
  text: z.string().trim().min(1).max(100000),
  clientNonce: Key,
  token: z.string().min(32).max(256),
  installationId: Key,
  profileId: Key,
  revision: z.number().int().positive(),
  engineVersion: Key,
  target: z.enum(["workspace", "computer"]),
  model: Key.optional(),
});
export type HostStart = z.infer<typeof HostStartSchema>;
export const HostDispatchSchema = z.object({
  instructions: z.string(),
  context: z.array(
    z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() }),
  ),
  session: z.object({ id: Key, engineVersion: Key }).optional(),
});
export const hostExecutionContract = {
  tool: oc
    .input(HostGrantSchema.extend({ id: Key, call: HostComputerCallSchema }))
    .output(z.object({ result: z.string() })),
  start: oc.input(HostStartSchema).output(
    HostGrantSchema.extend({
      taskId: Id,
      seq: z.number().int(),
      threadId: Id,
      userId: Id,
      spaceId: Id,
      generation: Key,
      leaseExpiresAt: z.string(),
      cursor: z.number().int(),
      stopped: z.boolean(),
    }).extend(HostDispatchSchema.shape),
  ),
  sync: oc.input(HostGrantSchema.extend({ frames: z.array(HostFrameSchema).max(128) })).output(
    z.object({
      after: z.number().int(),
      leaseExpiresAt: z.string(),
      stopped: z.boolean(),
      answers: z.array(z.object({ requestId: Key, answer: z.string() })),
    }),
  ),
  answer: oc
    .input(HostGrantSchema.extend({ messageId: Id, answer: z.string().min(1).max(16384) }))
    .output(z.object({ ok: z.boolean() })),
};

export interface DesktopHostProfile {
  id: string;
  label: string;
  status: "ready" | "missing" | "unsupported" | "unauthenticated";
}
export interface DesktopHostSelection {
  profileId: string;
  target: "workspace" | "computer";
  workspace: string;
  model?: string;
}
export interface DesktopHostBridge {
  profiles(input: { spaceId: string }): Promise<DesktopHostProfile[]>;
  selection(input: { botId: string; spaceId: string }): Promise<DesktopHostSelection | null>;
  configure(input: {
    botId: string;
    spaceId: string;
    profileId: string | null;
    target?: "workspace" | "computer";
  }): Promise<DesktopHostSelection | null>;
  send(input: {
    botId: string;
    spaceId: string;
    text: string;
    clientNonce: string;
  }): Promise<{ runId: string; taskId: string; seq: number }>;
  answer(input: { runId: string; messageId: string; answer: string }): Promise<boolean>;
  stop(input: { botId: string; spaceId: string }): Promise<void>;
  disconnect(input?: Record<string, never>): Promise<void>;
}
