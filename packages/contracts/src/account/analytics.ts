import { z } from "zod";
import {
  BILLING_CANCELLATION_REASONS,
  ByokIntervalSchema,
  ByokTierSchema,
} from "../billing/billing.js";
import { RUN_ERROR_KINDS, RunTriggerSchema } from "../runs/runs.js";
import { SIGNUP_SURVEY_TEAM_SIZES, SIGNUP_SURVEY_USES } from "./me.js";
import { SignupAttribution } from "./signup-attribution.js";

// Explicitly validated fields only: this is also the final allowlist at the external boundary.
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
  "plans",
]);
export const AnalyticsSurface = z.enum(["web", "desktop", "ios", "android"]);
/** The app's store version, plus `+` and the short id of the over-the-air update it runs. */
export const AnalyticsAppVersion = z
  .string()
  .max(40)
  .regex(/^\d+(\.\d+){0,3}(\+[0-9a-f]{8})?$/);
export const AnalyticsScreenInput = z
  .object({
    screen: AnalyticsScreen,
    surface: AnalyticsSurface,
  })
  .strict();
export const AnalyticsBotSetting = z.enum([
  "name",
  "description",
  "instructions",
  "avatar",
  "notifications",
  "memory",
  "voice",
  "auto_speak",
  "model",
  "thinking",
  "computer",
  "team_chat",
  "cross_space",
  "daily_check_ins",
  "fleet_management",
  "reply_mode",
  "tools",
]);
export const AnalyticsTrigger = RunTriggerSchema;
/** A coarse failure class; "other" covers everything without a known kind. Never the error text. */
export const AnalyticsErrorKind = z.enum([...RUN_ERROR_KINDS, "other"]);
export const AnalyticsModelConnectMethod = z.enum(["api_key", "oauth", "credits", "compatible"]);
const modelConnect = {
  method: AnalyticsModelConnectMethod,
  // A model catalog provider id, checked against the fixed catalog by the caller.
  provider: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  /** Absent only where no app is involved, such as a payment that lands later. */
  surface: AnalyticsSurface.optional(),
  /** Which of this person's tries at connecting a model this is, counted from one. */
  attempt: z.number().int().positive().optional(),
};
/** A code typed on the provider's page, or a link whose code comes back to the app. */
export const AnalyticsModelSignInFlow = z.enum(["device_code", "paste_code"]);
export const AnalyticsModelSignInStep = z.enum(["page_opened", "code_copied"]);
/** Why a sign-in that issued a link or code did not connect. */
export const AnalyticsModelSignInEndReason = z.enum([
  // The provider said the code ran out.
  "expired",
  // The person chose Cancel, or an older app that sends no reason stopped it.
  "cancelled",
  // A newer try, or another provider, method or model, took its place.
  "replaced",
  // The person left the screen or closed it.
  "left",
  "provider_refused",
  // The wait for the person ran out.
  "timed_out",
  // The provider accepted the sign-in, and saving the connection failed.
  "save_failed",
  // Its server stopped, or the app gave up on its own error.
  "interrupted",
]);
/** The reasons an app gives when it stops a sign-in itself. */
export const ModelSignInCancelReason = AnalyticsModelSignInEndReason.extract([
  "cancelled",
  "replaced",
  "left",
  "interrupted",
]);
/** What the provider refused, as a class. Never its message. */
export const AnalyticsModelSignInErrorClass = z.enum([
  "denied",
  "invalid_code",
  "rejected",
  "rate_limited",
  "unavailable",
  "other",
]);
const modelSignIn = { ...modelConnect, flow: AnalyticsModelSignInFlow };
const durationMs = z.number().int().nonnegative();
export const AnalyticsModelSignInStepInput = z
  .object({ loginId: z.string().min(1).max(64), step: AnalyticsModelSignInStep })
  .strict();
export const AnalyticsPlan = z.enum(["own_key", "credits"]);
/** A paid plan and what it bills each period; credits bill monthly and have no tier. */
const planTerms = {
  plan: AnalyticsPlan,
  tier: ByokTierSchema.optional(),
  interval: ByokIntervalSchema,
  amountCents: z.number().int().positive(),
};
/**
 * The mails of a person's lifecycle sequence. One job sends each, no two within a day of each
 * other, and each at most once per person.
 */
export const LIFECYCLE_EMAIL_KINDS = ["model-connection", "agent-import"] as const;
export const LifecycleEmailKind = z.enum(LIFECYCLE_EMAIL_KINDS);
export type LifecycleEmailKind = z.infer<typeof LifecycleEmailKind>;

export const AnalyticsEvent = z.discriminatedUnion("name", [
  SignupAttribution.extend({ name: z.literal("account_created") }).strict(),
  z.object({ name: z.literal("signed_in") }).strict(),
  z.object({ name: z.literal("screen_viewed"), ...AnalyticsScreenInput.shape }).strict(),
  z.object({ name: z.literal("message_sent"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_started"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_completed"), trigger: AnalyticsTrigger }).strict(),
  z
    .object({
      name: z.literal("run_failed"),
      trigger: AnalyticsTrigger,
      errorKind: AnalyticsErrorKind,
    })
    .strict(),
  z
    .object({
      name: z.literal("model_connect_started"),
      ...modelConnect,
      appVersion: AnalyticsAppVersion.optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("model_connected"),
      ...modelConnect,
      flow: AnalyticsModelSignInFlow.optional(),
      /** From the sign-in's link or code to the saved connection. */
      durationMs: durationMs.optional(),
    })
    .strict(),
  z.object({ name: z.literal("model_connect_code_issued"), ...modelSignIn }).strict(),
  z.object({ name: z.literal("model_connect_page_opened"), ...modelSignIn }).strict(),
  z.object({ name: z.literal("model_connect_code_copied"), ...modelSignIn }).strict(),
  // Every sign-in that issued a link or code and did not connect, once. Its failures are
  // counted here only: model_connect_failed covers a try that never issued a link or code.
  z
    .object({
      name: z.literal("model_connect_ended"),
      ...modelSignIn,
      reason: AnalyticsModelSignInEndReason,
      errorClass: AnalyticsModelSignInErrorClass.optional(),
      durationMs,
    })
    .strict(),
  z
    .object({
      name: z.literal("model_connect_failed"),
      ...modelConnect,
      errorKind: AnalyticsErrorKind,
    })
    .strict(),
  // An app connection turning connected. Only an id from the fixed integrations catalog, checked
  // by the caller; never the account or its name.
  z
    .object({
      name: z.literal("tool_connected"),
      app: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .optional(),
    })
    .strict(),
  // A manual edit in bot settings; which setting only, never its value.
  z.object({ name: z.literal("bot_setting_changed"), setting: AnalyticsBotSetting }).strict(),
  // Someone asked for a computer to be repaired; whether it worked shows in the logs.
  z
    .object({
      name: z.literal("computer_repair_started"),
      action: z.enum(["reset", "recover"]),
    })
    .strict(),
  // Only the fixed choices; free-text answers stay in the database.
  z
    .object({
      name: z.literal("signup_survey_answered"),
      skipped: z.boolean(),
      use: z.enum(SIGNUP_SURVEY_USES).optional(),
      teamSize: z.enum(SIGNUP_SURVEY_TEAM_SIZES).optional(),
    })
    .strict(),
  z.object({ name: z.literal("checkout_opened"), ...planTerms }).strict(),
  z.object({ name: z.literal("subscription_started"), ...planTerms, trial: z.boolean() }).strict(),
  // A trial's end: its first payment, or access lost without one. A failed first charge that is
  // settled later reports again as converted, so a subscription converted if any report says so.
  z.object({ name: z.literal("trial_ended"), ...planTerms, converted: z.boolean() }).strict(),
  // Which lifecycle mail went out; never the address or the person.
  z.object({ name: z.literal("lifecycle_email_sent"), email: LifecycleEmailKind }).strict(),
  // Only the fixed reason; the comment stays in the database.
  z
    .object({
      name: z.literal("subscription_cancel_feedback"),
      reason: z.enum(BILLING_CANCELLATION_REASONS).optional(),
      commented: z.boolean(),
    })
    .strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

export type AnalyticsScreen = z.infer<typeof AnalyticsScreen>;
export type AnalyticsErrorKind = z.infer<typeof AnalyticsErrorKind>;
export type AnalyticsBotSetting = z.infer<typeof AnalyticsBotSetting>;
export type AnalyticsModelConnectMethod = z.infer<typeof AnalyticsModelConnectMethod>;
export type AnalyticsSurface = z.infer<typeof AnalyticsSurface>;
export type AnalyticsModelSignInFlow = z.infer<typeof AnalyticsModelSignInFlow>;
export type AnalyticsModelSignInStep = z.infer<typeof AnalyticsModelSignInStep>;
export type AnalyticsModelSignInEndReason = z.infer<typeof AnalyticsModelSignInEndReason>;
export type ModelSignInCancelReason = z.infer<typeof ModelSignInCancelReason>;
export type AnalyticsModelSignInErrorClass = z.infer<typeof AnalyticsModelSignInErrorClass>;
