import * as z from "zod";
import { Id } from "../ids.js";

export const AccessGrantInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email(),
    creditCents: z.number().int().min(0).max(100_000).default(0),
    freeMonths: z.number().int().min(0).max(12).default(0),
  })
  .refine((grant) => grant.creditCents > 0 || grant.freeMonths > 0, {
    message: "Grant credits, free months, or both",
  });
export type AccessGrantInput = z.input<typeof AccessGrantInputSchema>;

export const AccessGrantSchema = z.object({
  id: Id,
  email: z.string(),
  creditCents: z.number().int(),
  freeMonths: z.number().int(),
  createdBy: z.string().nullable(),
  status: z.enum(["pending", "applied", "revoked"]),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
});
export type AccessGrant = z.infer<typeof AccessGrantSchema>;
