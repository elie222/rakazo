import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { RunsListOutputSchema, ToolCallsOutputSchema } from "./runs.js";

export const runsRpc = {
  runs: {
    list: oc.input(z.object({ filter: z.enum(["active", "recent"]) })).output(RunsListOutputSchema),
    /**
     * One of the owner's runs' failed or shortened tool call records, oldest first. Bounded by the
     * records kept per run, and empty for anyone else's run.
     */
    toolCalls: oc.input(z.object({ runId: Id })).output(ToolCallsOutputSchema),
  },
};
