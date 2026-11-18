import * as z from "zod";
import { BotSchema, BotSectionSchema } from "../bots/bot.js";
import { BotAvatarSetSchema } from "../bots/bot-avatar.js";
import { NavLinkSchema } from "../clients/nav-links.js";
import { Id } from "../ids.js";
import { LabFeatureSchema } from "../labs.js";
import { RoutineSchema } from "../routines/routine.js";
import { GroupSchema } from "../spaces/groups.js";
import { SpaceSchema } from "../spaces/space.js";
import { ThreadSnapshotSchema } from "../threads/thread.js";
import { AvatarStyleSchema } from "./preferences.js";

export const MeSchema = z.object({
  maxUploadSizeBytes: z.number().int().positive().optional(),
  maxAttachmentsPerMessage: z.number().int().positive().optional(),
  /** Labs features this account turned on. Absent from servers that predate Labs. */
  labs: z.array(LabFeatureSchema).default([]),
  /** Labs features this account can switch; the deployment turns the rest on for everyone. */
  labsAvailable: z.array(LabFeatureSchema).default([]),
  /** Deprecated: whether `labs` includes "board", kept for apps that predate Labs. */
  ticketBoardEnabled: z.boolean(),
  phoneCallsEnabled: z.boolean().default(false),
  /** Operator-configured menu links. Absent from older servers. */
  navLinks: z.array(NavLinkSchema).default([]),
  userId: Id,
  email: z.string().email(),
  name: z.string(),
  spaceId: Id,
  /** Deprecated: app accounts never have server administrator privileges. Always false. */
  isDeploymentOwner: z.boolean(),
  /** Listed in RAKAZO_ADMIN_EMAILS with a verified email: reviews plugins, adds stdio MCP servers, grants access. */
  isAdmin: z.boolean().default(false),
  needsModel: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  /** Provider the active default runs on with the server's own credentials, without a key. */
  hostCredentialProvider: z.string().nullable(),
  /** Kind of those credentials, e.g. "AWS IAM"; set with hostCredentialProvider. */
  hostCredentialSource: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
  sandboxProvider: z.string(),
  /** Whether Settings may choose where computers run. Absent from older servers. */
  computerSettingsEnabled: z.boolean().optional(),
  /** Whether this account can add stdio MCP servers here. Absent from older servers. */
  mcpStdioEnabled: z.boolean().default(false),
  avatarStyle: AvatarStyleSchema,
  /** The icon set new and unpinned bots wear. Absent from servers that predate it. */
  botAvatarSet: BotAvatarSetSchema.optional(),
  /**
   * The user's IANA timezone, or null when unset (bots then see UTC only).
   * Absent from servers that predate it.
   */
  timezone: z.string().nullable().optional(),
  /**
   * The app language last reported for the user, or null until an app reports it.
   * Absent from servers that predate it.
   */
  locale: z.string().nullable().optional(),
  billingEnabled: z.boolean(),
  /** True until a user of a billing deployment answers or skips the signup survey. Absent from older servers. */
  needsSignupSurvey: z.boolean().optional(),
  /** The wallet bots can spend from, when this deployment offers one. Absent from older servers. */
  paymentWalletProvider: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});
export type Me = z.infer<typeof MeSchema>;

export const SIGNUP_SURVEY_USES = ["personal", "work", "both"] as const;
export const SIGNUP_SURVEY_TEAM_SIZES = ["1", "2-10", "11-50", "51-200", "201+"] as const;

/** Team sizes as shown: en dashes for ranges, and the open-ended bucket as "200+". */
export function signupSurveyTeamSizeLabel(size: (typeof SIGNUP_SURVEY_TEAM_SIZES)[number]): string {
  return size === "201+" ? "200+" : size.replace("-", "–");
}

/** Every answer is optional; an empty survey records that the user skipped it. */
export const SignupSurveySchema = z.object({
  reason: z.string().trim().max(2000).optional(),
  use: z.enum(SIGNUP_SURVEY_USES).optional(),
  /** Only kept when the survey asks it; see signupSurveyAsksTeamSize. */
  teamSize: z.enum(SIGNUP_SURVEY_TEAM_SIZES).optional(),
  source: z.string().trim().max(500).optional(),
});
export type SignupSurvey = z.infer<typeof SignupSurveySchema>;

export function signupSurveyAsksTeamSize(use: SignupSurvey["use"]): boolean {
  return use === "work" || use === "both";
}

export const AppBootstrapSchema = z.object({
  me: MeSchema,
  bots: z.array(BotSchema),
  groups: z.array(GroupSchema),
  botSections: z.array(BotSectionSchema),
  archivedBots: z.array(BotSchema),
  archivedGroups: z.array(GroupSchema),
  thread: ThreadSnapshotSchema.nullable(),
  routines: z.array(RoutineSchema),
  spaces: z.array(SpaceSchema),
  /** Set when the requested bot is the caller's but lives in another of their Spaces. */
  botSpaceId: Id.optional(),
  /** Set when the requested group is one the caller can open in another of their Spaces. */
  groupSpaceId: Id.optional(),
});
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>;
