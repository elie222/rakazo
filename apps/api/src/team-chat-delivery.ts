import type { MessageBlock } from "@rakazo/contracts";
import { teamChatResponseText } from "@rakazo/core";
import type { TargetBot, TeamChatBridgeDeps } from "./team-chat-bridge.js";

const DELIVERY_RESERVATION_MS = 2 * 60_000;

/** Posts a finished run's reply to team chat at most once per message. */
export class TeamChatDelivery {
  constructor(
    private readonly deps: Pick<TeamChatBridgeDeps, "prisma" | "send">,
    private readonly target: () => TargetBot | undefined,
  ) {}

  async deliverCompletion(message: {
    id: string;
    runId: string | null;
    kind: string;
    replyThreadId: string | null;
    externalConversation: { conversationId: string };
  }): Promise<void> {
    if (!message.runId) throw new Error("Completed team chat message has no run");
    const response = await this.deps.prisma.message.findFirst({
      where: { runId: message.runId, role: "bot" },
      orderBy: { seq: "desc" },
      select: { blocks: true },
    });
    const blocks = Array.isArray(response?.blocks) ? (response.blocks as MessageBlock[]) : [];
    const content = teamChatResponseText(blocks, this.target()?.name, message.kind === "ambient");
    if (!content) {
      await this.markDelivered(message.id, "silent");
      return;
    }
    const reserved = await this.reserveDelivery(message.id);
    if (!reserved) return;
    await this.sendOnce(message.id, {
      conversationId: message.externalConversation.conversationId,
      replyThreadId: message.replyThreadId,
      content,
      idempotencyKey: `external-message:${message.id}`,
    });
  }

  async deliverFailure(message: {
    id: string;
    kind: string;
    replyThreadId: string | null;
    externalConversation: { conversationId: string };
  }): Promise<void> {
    if (message.kind === "ambient") {
      await this.markDelivered(message.id, "silent-failure");
      return;
    }
    const reserved = await this.reserveDelivery(message.id);
    if (!reserved) return;
    await this.sendOnce(message.id, {
      conversationId: message.externalConversation.conversationId,
      replyThreadId: message.replyThreadId,
      content: `${this.target()?.name ?? "The agent"} could not complete that request. Open Rakazo for details.`,
      idempotencyKey: `external-message:${message.id}:failure`,
    });
  }

  /**
   * Post at most once per reserved message. If a prior attempt already stored
   * a provider handle, finalize without sending again. Persist the handle
   * before flipping status so a crash mid-ack cannot reclaim into a duplicate.
   */
  private async sendOnce(
    id: string,
    request: {
      conversationId: string;
      replyThreadId: string | null;
      content: string;
      idempotencyKey: string;
    },
  ): Promise<void> {
    const existing = await this.deps.prisma.externalMessage.findUnique({
      where: { id },
      select: { providerReplyHandle: true },
    });
    if (existing?.providerReplyHandle) {
      await this.markDelivered(id, existing.providerReplyHandle);
      return;
    }
    const sent = await this.deps.send(request);
    await this.deps.prisma.externalMessage.update({
      where: { id },
      data: { providerReplyHandle: sent.handle },
    });
    await this.markDelivered(id, sent.handle);
  }

  private async reserveDelivery(id: string): Promise<boolean> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + DELIVERY_RESERVATION_MS);
    const claimed = await this.deps.prisma.externalMessage.updateMany({
      where: { id, status: "running", providerReplyHandle: null },
      data: {
        status: "delivering",
        nextAttemptAt: leaseUntil,
      },
    });
    if (claimed.count === 1) return true;

    // Already posted but status flip was lost — finish without a second send.
    const posted = await this.deps.prisma.externalMessage.findFirst({
      where: { id, status: "delivering", providerReplyHandle: { not: null } },
      select: { providerReplyHandle: true },
    });
    if (posted?.providerReplyHandle) {
      await this.markDelivered(id, posted.providerReplyHandle);
      return false;
    }

    // Expired lease with no handle: the prior attempt may have reached the
    // provider. Prefer a lost reply over a duplicate post.
    await this.deps.prisma.externalMessage.updateMany({
      where: {
        id,
        status: "delivering",
        providerReplyHandle: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: "delivered",
        providerReplyHandle: "unconfirmed",
        deliveredAt: now,
        nextAttemptAt: null,
        lastError: "Delivery confirmation lost; skipped retry to avoid duplicates",
      },
    });
    return false;
  }

  async markDelivered(id: string, handle: string): Promise<void> {
    await this.deps.prisma.externalMessage.update({
      where: { id },
      data: {
        status: "delivered",
        providerReplyHandle: handle,
        deliveredAt: new Date(),
        lastError: null,
        nextAttemptAt: null,
      },
    });
  }
}
