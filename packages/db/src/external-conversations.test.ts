import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createExternalConversationRepos } from "./external-conversations.js";

describe("external conversations", () => {
  it("lists authorized conversations with their transcript preview", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "external-1",
        spaceId: "space-1",
        botId: "bot-1",
        provider: "slack",
        displayName: "Morgan, Pat, Chief",
        participantNames: ["Morgan", "Pat", "Chief"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: { "B-GITHUB": { name: "GitHub", mode: "ignore" } },
        updatedAt: new Date("2026-09-01T12:30:00.000Z"),
        messages: [
          { senderId: "B-GITHUB", senderName: "GitHub" },
          { senderId: "B-GITHUB", senderName: "GitHub" },
        ],
        thread: {
          id: "thread-1",
          unread: false,
          messages: [{ blocks: [{ kind: "text", text: "GROUP DM OK" }] }],
        },
      },
    ]);
    const repos = createExternalConversationRepos({
      externalConversation: { findMany },
    } as unknown as PrismaClient);

    await expect(
      repos.listForSpaces(
        {
          spaceId: "space-1",
          userId: "user-1",
          email: "owner@example.test",
          isDeploymentOwner: true,
        },
        ["space-1"],
      ),
    ).resolves.toEqual([
      {
        id: "external-1",
        spaceId: "space-1",
        botId: "bot-1",
        provider: "slack",
        displayName: "Morgan, Pat, Chief",
        participantNames: ["Morgan", "Pat", "Chief"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: { "B-GITHUB": { name: "GitHub", mode: "ignore" } },
        automatedSenders: [{ id: "B-GITHUB", name: "GitHub" }],
        threadId: "thread-1",
        preview: "GROUP DM OK",
        unread: false,
        updatedAt: "2026-09-01T12:30:00.000Z",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: { in: ["space-1"] },
          bot: { archivedAt: null },
          thread: { isNot: null },
        },
      }),
    );
  });

  it("updates policy only inside the actor's current space", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany },
    } as unknown as PrismaClient);
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "owner@example.test",
      isDeploymentOwner: true,
    };
    const policy = {
      teamChatAmbientEnabled: true,
      teamChatRules: "Engage on changed commitments.",
      automatedSenderPolicies: {
        "B-GITHUB": { name: "GitHub", mode: "action" as const },
      },
    };

    await expect(repos.updatePolicy(actor, "external-1", policy)).resolves.toEqual(policy);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "external-1", spaceId: "space-1" },
      data: policy,
    });
  });

  it("rejects policy updates outside the actor's current space", async () => {
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient);

    await expect(
      repos.updatePolicy(
        {
          spaceId: "space-1",
          userId: "user-1",
          email: "owner@example.test",
          isDeploymentOwner: true,
        },
        "external-2",
        {
          teamChatAmbientEnabled: false,
          teamChatRules: null,
          automatedSenderPolicies: {},
        },
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
