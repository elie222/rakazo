import * as z from "zod";
import { Id } from "../ids.js";
import { PersonSchema } from "./person.js";

/** The organization's one owner, admins who manage its members with them, and everyone else. */
export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationMemberSchema = PersonSchema.extend({
  role: OrganizationRoleSchema,
  /** Whether the viewer may remove them: never the owner or themselves. */
  manageable: z.boolean(),
  /** Whether the viewer may make them an admin or a member: not while their removal is unfinished. */
  roleChangeable: z.boolean(),
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const OrganizationInvitationSchema = z.object({
  id: Id,
  email: z.string(),
  /** The link to accept it, for sharing by hand when no email arrives. */
  url: z.string().url(),
  expiresAt: z.string(),
});
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;

export const OrganizationMembersSchema = z.object({
  members: z.array(OrganizationMemberSchema),
  /** Pending invitations; empty for someone who cannot manage members. */
  invitations: z.array(OrganizationInvitationSchema),
  /** True for the owner and admins: they invite, change roles and remove people. */
  canManage: z.boolean(),
});
export type OrganizationMembers = z.infer<typeof OrganizationMembersSchema>;

export const OrganizationInvitationPreviewSchema = z.object({
  organizationName: z.string(),
  inviterName: z.string(),
});
export type OrganizationInvitationPreview = z.infer<typeof OrganizationInvitationPreviewSchema>;

/** Every organization the signed-in user belongs to, and which one the current Space belongs to. */
export const OrganizationListSchema = z.object({
  activeOrganizationId: Id,
  organizations: z.array(
    z.object({
      id: Id,
      name: z.string(),
      /** Where the user lands in it: its default Space if they belong to it, else their own. */
      defaultSpaceId: Id,
      spaceIds: z.array(Id),
      /** Whether the user owns it, so can rename or delete it. */
      canManage: z.boolean(),
      role: OrganizationRoleSchema,
      /** Everyone in it but guests, the user included. */
      memberCount: z.number().int().positive(),
    }),
  ),
});
export type OrganizationList = z.infer<typeof OrganizationListSchema>;
