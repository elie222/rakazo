import { AutomatedSenderPoliciesSchema } from "@rakazo/contracts";
import { teamChatAmbientPrompt } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import type { TargetBot, TeamChatBridgeDeps } from "./team-chat-bridge.js";

const DEFAULT_AMBIENT_DEBOUNCE_MS = 15_000;
const AMBIENT_BATCH_SIZE = 100;
const AMBIENT_CONTEXT_MESSAGES = 20;

/** Decides which observed team chat messages the bot should answer unprompted. */
export class TeamChatAmbient {
  constructor(
    private readonly deps: Pick<
      TeamChatBridgeDeps,
      "prisma" | "judge" | "providerId" | "ambientDebounceMs"
    >,
    private readonly target: () => TargetBot | undefined,
    private readonly conversationScope: () => Prisma.ExternalConversationWhereInput,
  ) {}

  async evaluateAmbient(now: Date): Promise<void> {
    const target = this.target();
    if (!target) return;
    const observed = await this.deps.prisma.externalMessage.findMany({
      where: {
        status: "observed",
        threadMessageId: { not: null },
        externalConversation: {
          ...this.conversationScope(),
        },
      },
      include: { externalConversation: true },
      orderBy: { createdAt: "asc" },
      take: AMBIENT_BATCH_SIZE,
    });
    if (!observed.length) return;
    const policy = await this.deps.prisma.bot.findFirst({
      where: { id: target.id, archivedAt: null },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        name: true,
        modelProvider: true,
        modelId: true,
        teamChatAmbientEnabled: true,
        teamChatRules: true,
      },
    });
    if (!policy) return;
    const byConversation = new Map<string, typeof observed>();
    for (const message of observed) {
      const batch = byConversation.get(message.externalConversationId) ?? [];
      batch.push(message);
      byConversation.set(message.externalConversationId, batch);
    }
    const cutoff = now.getTime() - (this.deps.ambientDebounceMs ?? DEFAULT_AMBIENT_DEBOUNCE_MS);
    for (const messages of byConversation.values()) {
      const conversation = messages[0]?.externalConversation;
      if (!conversation) continue;
      const ambientEnabled = conversation.teamChatAmbientEnabled ?? policy.teamChatAmbientEnabled;
      // Blank room instructions follow the bot, as the settings screens show them.
      const rules = conversation.teamChatRules || policy.teamChatRules;
      const parsedPolicies = AutomatedSenderPoliciesSchema.safeParse(
        conversation.automatedSenderPolicies,
      );
      const automatedSenderPolicies = parsedPolicies.success ? parsedPolicies.data : {};
      if (!ambientEnabled) {
        await this.markAmbientIgnored(messages, now);
        continue;
      }

      const ignored = messages.filter(
        (message) =>
          message.senderIsBot &&
          (automatedSenderPolicies[message.senderId]?.mode ?? "ignore") === "ignore",
      );
      if (ignored.length > 0) await this.markAmbientIgnored(ignored, now);
      const candidates = messages.filter((message) => !ignored.includes(message));
      if (candidates.length === 0) continue;

      const hasImmediateCandidate = candidates.some((message) => {
        if (!message.senderIsBot) return true;
        return automatedSenderPolicies[message.senderId]?.mode !== "rollup";
      });
      const evaluated = hasImmediateCandidate
        ? candidates
        : await this.dueRollupMessages(candidates, automatedSenderPolicies, now);
      const latest = evaluated.at(-1);
      if (!latest || latest.createdAt.getTime() > cutoff) continue;
      const judgedMessages = evaluated.slice(-AMBIENT_CONTEXT_MESSAGES);
      const actionable = [...judgedMessages]
        .reverse()
        .find(
          (message) =>
            message.senderIsBot && automatedSenderPolicies[message.senderId]?.mode === "action",
        );
      const decision = actionable
        ? {
            act: true,
            reason: `${actionable.senderName} is configured as actionable.`,
            askedByEventId: actionable.providerEventId,
          }
        : this.deps.judge
          ? await this.deps.judge.decide({
              bot: policy,
              channelId: latest.externalConversation.conversationId,
              channelName: latest.externalConversation.displayName ?? undefined,
              rules,
              messages: judgedMessages.map((message) => ({
                eventId: message.providerEventId,
                senderId: message.senderId,
                senderName: message.senderName,
                content: message.content,
              })),
            })
          : { act: false, reason: "Ambient engagement judge is unavailable." };
      const trigger =
        judgedMessages.find((message) => message.providerEventId === decision.askedByEventId) ??
        latest;
      if (!decision.act) {
        await this.markAmbientIgnored(evaluated, now);
        continue;
      }
      const promoted = await this.promoteAmbientTrigger(trigger.id, {
        judgedAt: now,
        engagementReason: decision.reason ?? null,
        batchContext: JSON.stringify({
          messageIds: judgedMessages.map(({ id }) => id),
          prompt: teamChatAmbientPrompt({
            provider: this.deps.providerId,
            channelId: latest.externalConversation.conversationId,
            channelName: latest.externalConversation.displayName,
            rules,
            reason: decision.reason,
            messages: judgedMessages.map((message) => ({
              senderId: message.senderId,
              senderName: message.senderName,
              content: message.content,
            })),
          }),
        }),
      });
      if (promoted)
        await this.markAmbientIgnored(
          evaluated.filter(({ id }) => id !== trigger.id),
          now,
        );
    }
  }

  private async promoteAmbientTrigger(
    id: string,
    data: { judgedAt: Date; engagementReason: string | null; batchContext: string },
  ): Promise<boolean> {
    const result = await this.deps.prisma.externalMessage.updateMany({
      where: { id, status: "observed" },
      data: { status: "received", ...data },
    });
    return result.count === 1;
  }

  private async markAmbientIgnored(messages: Array<{ id: string }>, judgedAt: Date): Promise<void> {
    if (messages.length === 0) return;
    await this.deps.prisma.externalMessage.updateMany({
      where: { id: { in: messages.map(({ id }) => id) }, status: "observed" },
      data: { status: "ignored", judgedAt },
    });
  }

  private async dueRollupMessages<
    T extends {
      externalConversationId: string;
      senderId: string;
      senderName: string;
    },
  >(
    messages: T[],
    policies: Record<string, { mode: string; rollupHours?: number }>,
    now: Date,
  ): Promise<T[]> {
    const dueSenders = new Set<string>();
    for (const senderId of new Set(messages.map((message) => message.senderId))) {
      const hours = policies[senderId]?.rollupHours;
      if (!hours) continue;
      const latest = await this.deps.prisma.externalMessage.findFirst({
        where: {
          externalConversationId: messages[0]?.externalConversationId,
          senderId,
          senderIsBot: true,
          judgedAt: { not: null },
        },
        orderBy: { judgedAt: "desc" },
        select: { judgedAt: true },
      });
      if (
        !latest?.judgedAt ||
        latest.judgedAt.getTime() <= now.getTime() - hours * 60 * 60 * 1000
      ) {
        dueSenders.add(senderId);
      }
    }
    return messages.filter((message) => dueSenders.has(message.senderId));
  }
}
