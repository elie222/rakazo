import * as z from "zod";

export const SharedModelMethodSchema = z.enum(["api_key", "oauth"]);
export const SharedModelConnectionSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  method: SharedModelMethodSchema,
});
export const SharedModelInputSchema = SharedModelConnectionSchema.extend({
  provider: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(500),
}).and(
  z.discriminatedUnion("method", [
    z.object({ method: z.literal("api_key"), apiKey: z.string().trim().min(8).max(4096) }),
    z.object({ method: z.literal("oauth"), binding: z.string().trim().min(1).max(100) }),
  ]),
);
export const SharedModelSettingsSchema = z.object({
  connection: SharedModelConnectionSchema.nullable(),
  providers: z.array(
    z.object({
      id: z.string(),
      methods: z.array(SharedModelMethodSchema),
      bindings: z.array(z.string()),
    }),
  ),
});
export type SharedModelConnection = z.infer<typeof SharedModelConnectionSchema>;
export type SharedModelInput = z.infer<typeof SharedModelInputSchema>;
