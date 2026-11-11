import * as z from "zod";
import { Id, SandboxKind } from "./ids.js";

export const ComputerModeSchema = z.enum(["team", "dedicated"]);
export type ComputerMode = z.infer<typeof ComputerModeSchema>;

/** How big a machine a cloud computer runs on. Providers without sizes ignore it. */
export const ComputerSizeSchema = z.enum(["standard", "large", "xlarge"]);
export type ComputerSize = z.infer<typeof ComputerSizeSchema>;

export const COMPUTER_UPDATE_STAGES = [
  "preparing",
  "saving",
  "recreating",
  "restoring",
  "reconnecting",
] as const;
export const ComputerUpdateSchema = z.object({
  canReleaseReservation: z.boolean().optional(),
  action: z.enum(["update", "recover"]),
  id: Id,
  botId: Id,
  name: z.string(),
  mode: ComputerModeSchema,
  status: z.enum(["queued", "running", "interrupted", "completed", "failed"]),
  stage: z.enum(COMPUTER_UPDATE_STAGES),
});
export type ComputerUpdate = z.infer<typeof ComputerUpdateSchema>;

export const ComputerStatusSchema = z.object({
  botId: Id,
  mode: ComputerModeSchema,
  kind: SandboxKind,
  state: z.enum(["stopped", "booting", "running", "suspended", "error"]),
  controlHolder: z.enum(["bot", "user", "none"]),
  controlBotId: Id.nullable(),
  takeoverRequested: z.boolean(),
  screenAvailable: z.boolean(),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  homeRevision: z.string().nullable(),
  busyBotName: z.string().nullable(),
  canUpdate: z.boolean(),
  terminalAvailable: z.boolean(),
  /** Set only while the user should see that the disk is nearly full. */
  diskFullPercent: z.number().int().min(0).max(100).optional(),
  /** True when other people share the Space, and with it this computer and its browser sign-ins. */
  shared: z.boolean().optional(),
  /** True when another person in the Space has control, so this viewer only watches. */
  controlledByOther: z.boolean().optional(),
  /** Who has control when it is someone else. */
  controlledByName: z.string().optional(),
  /** Another bot on this computer that holds its control, is working or waits for help. */
  otherBotName: z.string().optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

/** Whether the viewer holds this bot's control of its computer. */
export function userHoldsComputerControl(
  computer:
    | Pick<ComputerStatus, "controlHolder" | "controlBotId" | "controlledByOther">
    | null
    | undefined,
  botId: string | undefined,
): boolean {
  return Boolean(
    botId &&
      computer?.controlHolder === "user" &&
      computer.controlBotId === botId &&
      !computer.controlledByOther,
  );
}

/** Who is using the screen, when it is not free: the viewer, another person, or a working bot. */
export type ComputerControlUser =
  | { by: "you" }
  | { by: "person"; name: string | null }
  /** The viewer holds the computer through another of its bots. */
  | { by: "youWithBot"; name: string }
  | { by: "bot"; name: string };

/**
 * Who is using this bot's computer, in the order the screen says it. `busyBotName` is the bot whose
 * run keeps the screen, when one does.
 */
export function computerControlUser(
  computer: ComputerStatus | null | undefined,
  botId: string | undefined,
  busyBotName: string | null | undefined,
): ComputerControlUser | null {
  if (userHoldsComputerControl(computer, botId)) return { by: "you" };
  if (computer?.controlledByOther) return { by: "person", name: computer.controlledByName ?? null };
  if (
    computer?.otherBotName &&
    computer.controlHolder === "user" &&
    computer.controlBotId &&
    computer.controlBotId !== botId
  ) {
    return { by: "youWithBot", name: computer.otherBotName };
  }
  const bot = busyBotName || computer?.otherBotName;
  return bot ? { by: "bot", name: bot } : null;
}

/**
 * Whether the status says this bot's computer is free, so its open window should ask for control.
 * The server still decides; this only keeps a window from asking while someone is using it.
 */
export function computerFreeFor(
  computer: ComputerStatus | null | undefined,
  botId: string | undefined,
  busyBotName: string | null | undefined,
): boolean {
  return Boolean(
    botId &&
      computer?.botId === botId &&
      computer.state === "running" &&
      computer.kind !== "desktop" &&
      !computerControlUser(computer, botId, busyBotName),
  );
}

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

/** Public metadata only; adapter validation and constructor options stay server-side. */
export const ComputerProviderFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["text", "secret", "url", "select"]),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  validation: z.enum(["public-https"]).optional(),
  /** A saved credential must be re-entered when its destination changes. */
  destination: z.string().optional(),
});
export type ComputerProviderField = z.infer<typeof ComputerProviderFieldSchema>;
export const ComputerProviderDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  fields: z.array(ComputerProviderFieldSchema),
  capabilities: z.object({ perAccount: z.boolean() }),
});
export type ComputerProviderDescriptor = z.infer<typeof ComputerProviderDescriptorSchema>;
export const ComputerProviderSettingsSchema = z.object({
  provider: z.string(),
  defaultProvider: z.string(),
  providers: z.array(ComputerProviderDescriptorSchema),
  values: z.record(z.string(), z.string()),
  savedSecrets: z.record(z.string(), z.boolean()),
});
export type ComputerProviderSettings = z.infer<typeof ComputerProviderSettingsSchema>;
export const ComputerProviderUpdateSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  values: z.record(z.string().max(64), z.string().trim().max(4096)).default({}),
});
export type ComputerProviderUpdate = z.infer<typeof ComputerProviderUpdateSchema>;

/** The vCPUs and memory each computer size provides. */
export const COMPUTER_SIZE_SPECS: Record<ComputerSize, { vcpus: number; memoryGb: number }> = {
  standard: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};
