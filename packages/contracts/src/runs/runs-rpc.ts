import { oc } from "@orpc/contract";
import * as z from "zod";
import { RunsListOutputSchema } from "./runs.js";

export const runsRpc = {
  runs: {
    list: oc.input(z.object({ filter: z.enum(["active", "recent"]) })).output(RunsListOutputSchema),
  },
};
