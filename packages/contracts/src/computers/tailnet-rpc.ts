import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { TailnetConnectionConfigSchema, TailnetStatusSchema } from "../tailnet.js";

/** The signed-in member's own tailnet connection in the current Space. */
export const tailnetRpc = {
  tailnet: {
    status: oc.output(TailnetStatusSchema),
    /** Checks the OAuth client with the tailnet before saving it; replacing one keeps the bots. */
    connect: oc.input(TailnetConnectionConfigSchema).output(TailnetStatusSchema),
    disconnect: oc.output(TailnetStatusSchema),
    setBotAccess: oc
      .input(z.object({ botId: Id, enabled: z.boolean() }).strict())
      .output(TailnetStatusSchema),
  },
};
