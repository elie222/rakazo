import * as z from "zod";
import { Id } from "../ids.js";

export const TEAM_CHAT_RULES_MAX_LENGTH = 4000;
export const AutomatedSenderPolicyModeSchema = z.enum(["ignore", "rollup", "action", "user"]);
export type AutomatedSenderPolicyMode = z.infer<typeof AutomatedSenderPolicyModeSchema>;

export const AutomatedSenderPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    mode: AutomatedSenderPolicyModeSchema,
    rollupHours: z.number().int().min(1).max(720).optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.mode === "rollup" && policy.rollupHours === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Rollup policies require a frequency",
        path: ["rollupHours"],
      });
    }
  });
export type AutomatedSenderPolicy = z.infer<typeof AutomatedSenderPolicySchema>;

export const AutomatedSenderPoliciesSchema = z
  .record(z.string().trim().min(1).max(200), AutomatedSenderPolicySchema)
  .refine((policies) => Object.keys(policies).length <= 50, {
    message: "At most 50 automated sender policies are allowed",
  });
export type AutomatedSenderPolicies = z.infer<typeof AutomatedSenderPoliciesSchema>;

export const AutomatedSenderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
});
export type AutomatedSender = z.infer<typeof AutomatedSenderSchema>;

export const ExternalConversationPolicySchema = z.object({
  teamChatAmbientEnabled: z.boolean().nullable(),
  teamChatRules: z.string().max(TEAM_CHAT_RULES_MAX_LENGTH).nullable(),
  automatedSenderPolicies: AutomatedSenderPoliciesSchema,
});
export type ExternalConversationPolicy = z.infer<typeof ExternalConversationPolicySchema>;

export const UpdateExternalConversationPolicyInput = ExternalConversationPolicySchema.extend({
  externalConversationId: Id,
});
export type UpdateExternalConversationPolicyInput = z.infer<
  typeof UpdateExternalConversationPolicyInput
>;

export const ExternalConversationSchema = z.object({
  id: Id,
  spaceId: Id,
  botId: Id,
  provider: z.string(),
  displayName: z.string().nullable(),
  participantNames: z.array(z.string()),
  teamChatAmbientEnabled: z.boolean().nullable(),
  teamChatRules: z.string().nullable(),
  automatedSenderPolicies: AutomatedSenderPoliciesSchema,
  automatedSenders: z.array(AutomatedSenderSchema),
  threadId: Id,
  preview: z.string(),
  unread: z.boolean(),
  updatedAt: z.string(),
});
export type ExternalConversation = z.infer<typeof ExternalConversationSchema>;
