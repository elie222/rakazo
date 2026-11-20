import * as z from "zod";
import { BotSchema, BotSectionSchema } from "../bots/bot.js";
import { MemoryScopeSchema } from "../bots/bot-memory.js";
import { Id } from "../ids.js";
import { ExternalConversationSchema } from "../threads/external-conversations.js";
import { GroupSchema } from "./groups.js";
import { PersonSchema } from "./person.js";

/**
 * A space is a real privacy boundary, not just sidebar organization.
 * Bots are included so clients can keep every space visible without granting
 * those bots access to the currently active space.
 */
export const SpaceBotSchema = BotSchema.pick({
  id: true,
  spaceId: true,
  name: true,
  title: true,
  color: true,
  avatarSet: true,
  notifyOnFinish: true,
  pinned: true,
  sectionId: true,
  unread: true,
  snoozedUntil: true,
  parentBotId: true,
  preview: true,
  status: true,
  threadStatus: true,
  runErrorId: true,
  updatedAt: true,
});
export type SpaceBot = z.infer<typeof SpaceBotSchema>;

export const SpaceGroupSchema = GroupSchema.pick({
  id: true,
  spaceId: true,
  name: true,
  pinned: true,
  sectionId: true,
  members: true,
  preview: true,
  unread: true,
  snoozedUntil: true,
  updatedAt: true,
});
export type SpaceGroup = z.infer<typeof SpaceGroupSchema>;

export const SpaceSchema = z.object({
  id: Id,
  name: z.string(),
  isDefault: z.boolean(),
  /** True when the space has any bot or group, including archived. */
  hasContent: z.boolean(),
  /** True only when the current member owns the space and may rename it. */
  canRename: z.boolean().optional(),
  /** True only when the current member may delete this non-default space. */
  canDelete: z.boolean().optional(),
  /** True when more than one person belongs to the space. */
  shared: z.boolean().optional(),
  /** True when someone from outside the Space's organization belongs to it. */
  hasGuests: z.boolean().optional(),
  /** Every bot deleting the space removes, archived and other members' included. */
  botCount: z.number().int().nonnegative().optional(),
  bots: z.array(SpaceBotSchema),
  groups: z.array(SpaceGroupSchema),
  externalConversations: z.array(ExternalConversationSchema),
  botSections: z.array(BotSectionSchema),
});
export type Space = z.infer<typeof SpaceSchema>;

export const SpaceRoleSchema = z.enum(["owner", "member"]);

export const SpaceMemberSchema = PersonSchema.extend({
  role: SpaceRoleSchema,
  /** From outside the Space's organization: they see only the Spaces they were added to. */
  guest: z.boolean().optional(),
});
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;

export const SpaceMembersSchema = z.object({
  spaceName: z.string(),
  members: z.array(SpaceMemberSchema),
  /** True when the current member owns the space and may invite or remove people. */
  canManage: z.boolean(),
  /** For the owner: links created but not yet used or expired. */
  openInvites: z.number().int().nonnegative().optional(),
  /** For the owner: people in the Space's organization who are not in it yet. */
  addable: z.array(PersonSchema).optional(),
  /** For the owner: the Space's organization, which anyone invited from outside does not join. */
  organizationName: z.string().optional(),
});
export type SpaceMembers = z.infer<typeof SpaceMembersSchema>;

export const SpaceInviteLinkSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
  /** Whether the link was emailed to the address given; when not, the owner shares it by hand. */
  emailed: z.boolean().optional(),
});

export const SpaceInvitePreviewSchema = z.object({
  spaceId: Id,
  spaceName: z.string(),
  inviterName: z.string(),
  /** True when the signed-in person already belongs to the space. */
  alreadyMember: z.boolean(),
});
export type SpaceInvitePreview = z.infer<typeof SpaceInvitePreviewSchema>;

export const SpaceNavigationSchema = z.object({
  current: z.object({
    id: Id,
    name: z.string(),
    bots: z.array(BotSchema),
    groups: z.array(GroupSchema),
    externalConversations: z.array(ExternalConversationSchema),
    botSections: z.array(BotSectionSchema),
  }),
  spaces: z.array(SpaceSchema),
  /**
   * The server would still make this person their first bot: nothing in these Spaces, and no chat
   * in any Space they made. Clients send an empty account to onboarding only then. A server that
   * predates it leaves it out, and clients decide from `hasContent` as before.
   */
  firstBotDue: z.boolean().default(true),
});
export type SpaceNavigation = z.infer<typeof SpaceNavigationSchema>;

export const SpaceMemoryConfigSchema = z.object({
  provider: z.string(),
  settings: z.record(z.string(), z.string()),
  defaultMemoryScope: MemoryScopeSchema,
  updatedAt: z.string(),
  /** One line naming the connection, written by the provider. Absent from older servers. */
  connectionLabel: z.string().optional(),
});
export type SpaceMemoryConfig = z.infer<typeof SpaceMemoryConfigSchema>;

/** What a Space change signal tells apps to read again; each is a `notifications.subscribe` frame. */
export const SpaceChangeKind = z.enum([
  "computerUpdates",
  "runs",
  "routines",
  "meetings",
  "artifacts",
  "meetingCalendar",
]);
export type SpaceChangeKind = z.infer<typeof SpaceChangeKind>;
