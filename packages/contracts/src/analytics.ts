import { z } from "zod";
import { RunTriggerSchema } from "./runs.js";

// No free-form properties: this is also the final allowlist at the external boundary.
export const AnalyticsScreen = z.enum([
  "home",
  "chat",
  "onboarding",
  "settings",
  "integrations",
  "artifacts",
  "board",
  "computer",
  "search",
  "bot_profile",
  "routine",
  "new_bot",
]);
export const AnalyticsSurface = z.enum(["web", "desktop", "ios", "android"]);
export const AnalyticsScreenInput = z
  .object({
    screen: AnalyticsScreen,
    surface: AnalyticsSurface,
  })
  .strict();
export const AnalyticsTrigger = RunTriggerSchema;
export const AnalyticsEvent = z.discriminatedUnion("name", [
  z.object({ name: z.literal("account_created") }).strict(),
  z.object({ name: z.literal("signed_in") }).strict(),
  z.object({ name: z.literal("screen_viewed"), ...AnalyticsScreenInput.shape }).strict(),
  z.object({ name: z.literal("message_sent"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_started"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_completed"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_failed"), trigger: AnalyticsTrigger }).strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

export type AnalyticsScreen = z.infer<typeof AnalyticsScreen>;
