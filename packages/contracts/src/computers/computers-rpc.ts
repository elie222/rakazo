import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import {
  CloudComputersSchema,
  ComputerHomeVersionSchema,
  ComputerProviderSettingsSchema,
  ComputerProviderUpdateSchema,
  ComputerReleaseReasonSchema,
  ComputerScreenSchema,
  ComputerSizeSchema,
  ComputerStatusSchema,
  ComputerUpdateSchema,
} from "./computer.js";
import { ComputerCommandSchema } from "./computer-command.js";

export const computersRpc = {
  /** Admin choice of where new computers run, with that provider's connection settings. */
  computerProvider: {
    get: oc.output(ComputerProviderSettingsSchema),
    update: oc.input(ComputerProviderUpdateSchema).output(ComputerProviderSettingsSchema),
    /** The signed-in account's provider for Team Computers, over the default. */
    account: {
      get: oc.output(ComputerProviderSettingsSchema),
      update: oc.input(ComputerProviderUpdateSchema).output(ComputerProviderSettingsSchema),
    },
  },
  /** Null where sizes cannot be chosen: no plan prices them or the provider has one size. */
  cloudComputers: {
    list: oc.output(CloudComputersSchema.nullable()),
    /** Answers once the size is saved; callers read the list again on their own. */
    setSize: oc
      .input(z.object({ computerId: Id, size: ComputerSizeSchema }))
      .output(z.object({ ok: z.literal(true) })),
  },
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    recover: oc.input(botId).output(ComputerUpdateSchema),
    reset: oc.input(botId).output(ComputerStatusSchema),
    update: oc.input(botId).output(ComputerUpdateSchema),
    updates: oc.output(z.array(ComputerUpdateSchema)),
    releaseInterrupted: oc
      .input(z.object({ id: Id, workersStopped: z.literal(true) }))
      .output(z.object({ ok: z.literal(true) })),
    dismissUpdate: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    dismissDiskWarning: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    /** Earlier saved copies of the computer's home, newest first. */
    homeVersions: oc.input(botId).output(z.array(ComputerHomeVersionSchema)),
    /** Makes an earlier copy current; the stopped computer gets it on its next start. */
    restoreHomeVersion: oc
      .input(z.object({ botId: Id, versionId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc
      .input(
        z.object({
          botId: Id,
          reason: ComputerReleaseReasonSchema.optional(),
          /** The run a needs-you card answers; the release applies only while it waits on the caller. */
          runId: Id.optional(),
          /** The lease this page took; a late release from an old page leaves newer control alone. */
          leaseId: Id.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard", "scroll"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    downloadFile: oc
      .input(z.object({ botId: Id, path: z.string().min(1) }))
      .output(z.object({ path: z.string(), contentBase64: z.string() })),
    uploadFile: oc
      .input(
        z.object({
          botId: Id,
          path: z.string().min(1),
          contentBase64: z.string(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    terminalUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    commands: oc
      .input(botId)
      .output(z.array(ComputerCommandSchema.extend({ createdAt: z.string() }))),
    /** A `preview` read only watches, so it leaves the computer's sleep schedule alone. */
    screenUrl: oc
      .input(botId.extend({ preview: z.boolean().optional() }))
      .output(ComputerScreenSchema),
    /** A still of the screen as an image data URL, or null when the computer is not running. */
    preview: oc
      .input(
        z.object({
          botId: Id,
          /** The run a needs-you card shows; no image once that run stops waiting. */
          runId: Id.optional(),
        }),
      )
      .output(z.object({ image: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
};
