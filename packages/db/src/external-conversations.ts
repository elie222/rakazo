import {
  type Actor,
  AutomatedSenderPoliciesSchema,
  type ExternalConversation,
  type ExternalConversationPolicy,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { previewFromBlocks } from "./thread-listing.js";

export function createExternalConversationRepos(prisma: PrismaClient) {
  return {
    async listForSpaces(actor: Actor, spaceIds: string[]): Promise<ExternalConversation[]> {
      if (spaceIds.length === 0) return [];
      const conversations = await prisma.externalConversation.findMany({
        where: {
          spaceId: { in: spaceIds },
          userId: actor.userId,
          bot: { archivedAt: null },
          thread: { isNot: null },
        },
        select: {
          id: true,
          spaceId: true,
          botId: true,
          provider: true,
          displayName: true,
          participantNames: true,
          teamChatAmbientEnabled: true,
          teamChatRules: true,
          automatedSenderPolicies: true,
          updatedAt: true,
          messages: {
            where: { senderIsBot: true },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: { senderId: true, senderName: true },
          },
          thread: {
            select: {
              id: true,
              unread: true,
              messages: {
                orderBy: { seq: "desc" },
                take: 1,
                select: { blocks: true },
              },
            },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      });
      return conversations.map((conversation) => {
        if (!conversation.thread)
          throw new IsolationError("External conversation is missing its thread");
        return {
          id: conversation.id,
          spaceId: conversation.spaceId,
          botId: conversation.botId,
          provider: conversation.provider,
          displayName: conversation.displayName,
          participantNames: conversation.participantNames,
          teamChatAmbientEnabled: conversation.teamChatAmbientEnabled,
          teamChatRules: conversation.teamChatRules,
          automatedSenderPolicies: AutomatedSenderPoliciesSchema.parse(
            conversation.automatedSenderPolicies,
          ),
          automatedSenders: [
            ...new Map(
              conversation.messages.map(({ senderId, senderName }) => [
                senderId,
                { id: senderId, name: senderName },
              ]),
            ).values(),
          ],
          threadId: conversation.thread.id,
          preview: previewFromBlocks(conversation.thread.messages[0]?.blocks),
          unread: conversation.thread.unread,
          updatedAt: conversation.updatedAt.toISOString(),
        };
      });
    },
    async updatePolicy(
      actor: Actor,
      externalConversationId: string,
      policy: ExternalConversationPolicy,
    ): Promise<ExternalConversationPolicy> {
      const result = await prisma.externalConversation.updateMany({
        where: {
          id: externalConversationId,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        data: policy,
      });
      if (result.count !== 1) throw new IsolationError();
      return policy;
    },
  };
}
