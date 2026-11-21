import { oc } from "@orpc/contract";
import * as z from "zod";
import { BotAvatarSetSchema } from "../bots/bot-avatar.js";
import { Id } from "../ids.js";
import { LabFeatureSchema } from "../labs.js";
import { botId } from "../rpc/inputs.js";
import { SettingsScopeSchema } from "../settings-scope.js";
import { ExportManifestSchema } from "./account-export.js";
import { AiConsentQuerySchema, AiConsentStatusSchema } from "./ai-consent.js";
import { AnalyticsModelSignInStepInput, AnalyticsScreenInput } from "./analytics.js";
import { AuditEventListInputSchema, AuditEventPageSchema } from "./audit-events.js";
import { AppBootstrapSchema, MeSchema, SignupSurveySchema } from "./me.js";
import { AppLocaleSchema, AvatarStyleSchema, TimeZoneSchema } from "./preferences.js";
import { SecurityEventListInputSchema, SecurityEventSchema } from "./security-events.js";

export const accountRpc = {
  analytics: {
    screen: oc.input(AnalyticsScreenInput).output(z.object({ ok: z.literal(true) })),
    /** A step of a subscription sign-in only the app can see. */
    modelSignInStep: oc
      .input(AnalyticsModelSignInStepInput)
      .output(z.object({ ok: z.literal(true) })),
  },
  aiConsent: {
    status: oc.input(AiConsentQuerySchema).output(AiConsentStatusSchema),
    allow: oc
      .input(
        z.object({
          scope: z.string(),
          version: z.string(),
          keys: z.array(z.string()).min(1).max(200),
          pageId: z.string().optional(),
          /** The settings copy the reviewed recipients came from, as in `status`. */
          settingsScope: SettingsScopeSchema.optional(),
        }),
      )
      .output(AiConsentStatusSchema),
    revoke: oc.input(z.object({ key: z.string().nullable() })).output(AiConsentStatusSchema),
  },
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  preferences: {
    update: oc
      .input(
        z
          .object({
            avatarStyle: AvatarStyleSchema.optional(),
            /** Restyles every bot not pinned to another set, and is what new bots get. */
            botAvatarSet: BotAvatarSetSchema.optional(),
            timezone: TimeZoneSchema.nullable().optional(),
            /** The language the app runs in, so emails can be written in it. */
            locale: AppLocaleSchema.optional(),
            /** Replaces the account's Labs list. */
            labs: z.array(LabFeatureSchema).optional(),
          })
          .refine(
            (input) =>
              input.avatarStyle !== undefined ||
              input.botAvatarSet !== undefined ||
              input.timezone !== undefined ||
              input.locale !== undefined ||
              input.labs !== undefined,
            { message: "Nothing to update" },
          ),
      )
      .output(MeSchema),
    /** Saves a detected timezone only while none is saved, so it never replaces a choice. */
    adoptTimezone: oc.input(z.object({ timezone: TimeZoneSchema })).output(MeSchema),
  },
  bootstrap: oc
    .input(z.object({ botId: Id.optional(), groupId: Id.optional() }))
    .output(AppBootstrapSchema),
  /** Deployment-owner view of the append-only security event log, newest first. */
  security: {
    events: oc.input(SecurityEventListInputSchema).output(z.array(SecurityEventSchema)),
  },
  /** The organization's audit log, newest first: everyone's for owners and admins, a member's own otherwise. */
  audit: {
    events: oc.input(AuditEventListInputSchema).output(AuditEventPageSchema),
  },
  onboarding: {
    /** Record the optional signup survey; an empty submission marks it skipped. */
    signupSurvey: oc.input(SignupSurveySchema).output(z.object({ ok: z.literal(true) })),
    /**
     * The Space's first-run bot, created and greeted when the Space has never held a chat; null
     * once it has (or had) other bots, so deleting them never brings it back.
     */
    firstBot: oc.output(z.object({ botId: Id.nullable() })),
    /** Seed the first-run greeting into the bot's thread (focus card is separate). */
    start: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Post the focus choice card when the thread is still idle. */
    promptFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Answer the focus choice; posts the app cards. Does not rename the bot. */
    choose: oc
      .input(z.object({ botId: Id, optionId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Dismiss the unanswered focus card without choosing an option. */
    dismissFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Flip an app_connect card to connected after authorization completes. */
    appConnected: oc
      .input(
        z.object({
          botId: Id,
          threadId: Id.optional(),
          /** The card's own message, so it is found however far back it is. */
          messageId: Id.optional(),
          provider: z.string(),
          /** Omitted for the server's default connector. */
          connectorId: z.string().optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
    /**
     * A one-time token for `GET /api/account/export?token=`, which streams the account zip. Needs
     * a recent identity confirmation on this session (IDENTITY_CONFIRMATION_REQUIRED).
     */
    accountToken: oc.output(z.object({ token: z.string() })),
  },
};
