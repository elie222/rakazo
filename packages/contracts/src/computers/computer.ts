import * as z from "zod";
import { Id, IsoDate, SandboxKind } from "../ids.js";
import type { ProviderSettingsField } from "../models/provider-settings.js";
import { ProviderSettingsFieldSchema } from "../models/provider-settings.js";

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

/** The error code of a restore refused because the computer is running. */
export const COMPUTER_RUNNING_ERROR = "COMPUTER_RUNNING";

/** An earlier saved copy of a computer's home that its owner can restore. */
export const ComputerHomeVersionSchema = z.object({ id: Id, savedAt: IsoDate });
export type ComputerHomeVersion = z.infer<typeof ComputerHomeVersionSchema>;

/**
 * What the computer reports about its resources. Every field is read-only: a capability never
 * grants access, and an unknown value is not a denial.
 */
export const ComputerMemorySchema = z.object({
  vm: z
    .object({
      totalBytes: z.number().int().positive(),
      availableBytes: z.number().int().nonnegative(),
      stallPercent10s: z.number().min(0).max(100).optional(),
      pressure: z.enum(["normal", "high", "critical"]),
    })
    .optional(),
  currentBytes: z.number().int().nonnegative(),
  workingSetBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  swapBytes: z.number().int().nonnegative().optional(),
  swapLimitBytes: z.number().int().nonnegative().optional(),
  oomKills: z.number().int().nonnegative(),
  pressure: z.enum(["normal", "high", "critical"]),
});
export type ComputerMemory = z.infer<typeof ComputerMemorySchema>;

/**
 * What a computer offers beyond screenshots and coordinates. A server that cannot inspect the
 * computer omits this object; an older client must treat that as the previous behaviour.
 */
export const ComputerCapabilitiesSchema = z.object({
  version: z.literal(1),
  search: z.literal("service_path"),
  programs: z.record(z.string(), z.enum(["available", "not_on_path", "unknown"])),
  memory: ComputerMemorySchema.optional(),
  display: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  }),
  perception: z.object({
    atspi: z.boolean(),
    cdp: z.boolean(),
    hitTest: z.boolean(),
    settle: z.boolean(),
    zoom: z.boolean(),
  }),
  stream: z.object({
    protocol: z.enum(["vnc", "webrtc"]),
    quality: z.boolean(),
  }),
  recording: z.boolean(),
  desktopApps: z.boolean(),
});
export type ComputerCapabilities = z.infer<typeof ComputerCapabilitiesSchema>;

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
  /** True when the computer is the person's own machine, which has no remote screen to show. */
  runsOnUserMachine: z.boolean().optional(),
  /** Set only while the user should see that the disk is nearly full. */
  diskFullPercent: z.number().int().min(0).max(100).optional(),
  /** True when other people share the Space, and with it this computer and its browser sign-ins. */
  shared: z.boolean().optional(),
  /** True when another person in the Space has control, so this viewer only watches. */
  controlledByOther: z.boolean().optional(),
  /** The viewer's own control lease, set only for the person holding it; closing hands it back. */
  controlLeaseId: Id.optional(),
  /** What the computer can do beyond screenshots and coordinates. Older servers omit it. */
  capabilities: ComputerCapabilitiesSchema.optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const ComputerRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type ComputerRect = z.infer<typeof ComputerRectSchema>;

export const ComputerElementStateSchema = z.object({
  value: z.string().max(200).optional(),
  checked: z.enum(["true", "false", "mixed"]).optional(),
  disabled: z.boolean().optional(),
  expanded: z.boolean().optional(),
});
export type ComputerElementState = z.infer<typeof ComputerElementStateSchema>;

/** One accessible control the computer found, in model pixels. */
export const ComputerElementSchema = z.object({
  point: z.object({ x: z.number(), y: z.number() }),
  bbox: ComputerRectSchema.optional(),
  windowFrame: ComputerRectSchema.optional(),
  source: z.enum(["coords", "ax", "cdp"]),
  app: z.string().optional(),
  window: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  secret: z.boolean().optional(),
  editable: z.boolean().optional(),
  ref: z.string().optional(),
  state: ComputerElementStateSchema.optional(),
});
export type ComputerElement = z.infer<typeof ComputerElementSchema>;

/** Where a control was when the viewer picked it, for the server to re-resolve before clicking. */
export const ComputerTargetSchema = ComputerElementSchema.omit({ ref: true, state: true });
export type ComputerTarget = z.infer<typeof ComputerTargetSchema>;

export const ComputerFindResultSchema = z.object({
  elements: z.array(ComputerElementSchema).max(300),
  url: z.string().optional(),
  truncated: z.boolean(),
  unknown: z.boolean().optional(),
  /** The frame these elements were read from; pass it back to computer_act. */
  frameId: z.string().optional(),
});
export type ComputerFindResult = z.infer<typeof ComputerFindResultSchema>;

export const ComputerZoomResultSchema = z.object({
  frameId: z.string(),
  image: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ComputerZoomResult = z.infer<typeof ComputerZoomResultSchema>;

/** A computer screen to load, and how its URL signs the viewer in. */
export const ComputerScreenSchema = z.object({
  url: z.string().nullable(),
  /**
   * Set when the URL signs in with a code that works once and ends the session an earlier code
   * opened, so loading it a second time, or loading a newer one beside it, loses the screen.
   * `screen` names what the URL shows apart from that code: URLs with the same value show the
   * same screen. Absent when the URL can be loaded again, and from older servers.
   */
  singleUseSignIn: z.object({ screen: z.string() }).optional(),
});

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

export const ComputerProviderFieldSchema = ProviderSettingsFieldSchema;
export type ComputerProviderField = ProviderSettingsField;
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

/**
 * The Space's cloud computers whose size can be chosen. `available` is what the plan allows;
 * the larger sizes still show so an owner can see where an upgrade leads.
 */
export const CloudComputersSchema = z.object({
  computers: z.array(
    z.object({
      id: Id,
      scope: ComputerModeSchema,
      botName: z.string().nullable(),
      /** The size it starts at: the saved size, or the largest the plan allows below it. */
      size: ComputerSizeSchema,
      /** The size its owner chose, which `size` returns to if the plan grows again. */
      savedSize: ComputerSizeSchema,
    }),
  ),
  available: z.array(ComputerSizeSchema),
  /** Size changes what the organization's hours buy, so only who manages billing makes them. */
  canManage: z.boolean(),
});
export type CloudComputers = z.infer<typeof CloudComputersSchema>;

/** Record a confirmed size without inventing a missing row or overriding the list's plan limits. */
export function applySavedCloudComputerSize(
  listed: CloudComputers | null | undefined,
  computerId: string,
  size: ComputerSize,
): CloudComputers | undefined {
  if (!listed?.computers.some((computer) => computer.id === computerId)) return;
  return {
    ...listed,
    computers: listed.computers.map((computer) =>
      computer.id === computerId
        ? {
            ...computer,
            size: listed.available.includes(size) ? size : computer.size,
            savedSize: size,
          }
        : computer,
    ),
  };
}

/**
 * What picking `size` for a cloud computer does: an upgrade prompt when the plan excludes it,
 * nothing when it is already the saved size, otherwise a save. A plan that shrank shows the size
 * it allows, so picking that saves it in place of the larger saved size.
 */
export function computerSizeChoice(
  size: ComputerSize,
  computer: { savedSize: ComputerSize },
  available: readonly ComputerSize[],
): "upgrade" | "unchanged" | "save" {
  if (!available.includes(size)) return "upgrade";
  return size === computer.savedSize ? "unchanged" : "save";
}

/** The vCPUs and memory each computer size provides. */
export const COMPUTER_SIZE_SPECS: Record<ComputerSize, { vcpus: number; memoryGb: number }> = {
  standard: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};
