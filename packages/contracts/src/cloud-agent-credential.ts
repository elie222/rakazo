import * as z from "zod";
import { IsoDate } from "./ids.js";

/** Whether the signed-in user has saved a cloud-agent key. The key itself is never returned. */
export const CloudAgentCredentialStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("connected"), connectedAt: IsoDate }),
]);
export type CloudAgentCredentialStatus = z.infer<typeof CloudAgentCredentialStatusSchema>;
