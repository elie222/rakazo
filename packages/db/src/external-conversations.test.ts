import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "./scope.js";
import { createExternalConversationRepos } from "./external-conversations.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

describe("createExternalConversationRepos", () => {
  it("lists conversations for the actor's spaces", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "ext-1",
        spaceId: "space-1",
        botId: "bot-1",
        provider: "slack",
        displayName: "launch",
        participantNames: ["Ada"],
        teamChatAmbientEnabled: true,
        teamChatRules: "Ping on dates",
        automatedSenderPolicies: {},
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        messages: [{ senderId: "B1", senderName: "Pager" }],
        thread: {
          id: "thread-1",
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Latest" }] }],
        },
      },
    ]);
    const repos = createExternalConversationRepos({
      externalConversation: { findMany },
    } as never);

    await expect(repos.listForSpaces(actor, ["space-1"])).resolves.toEqual([
      expect.objectContaining({
        id: "ext-1",
        threadId: "thread-1",
        preview: "Latest",
        unread: true,
        automatedSenders: [{ id: "B1", name: "Pager" }],
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: { in: ["space-1"] },
          userId: "user-1",
        }),
      }),
    );
  });

  it("returns no rows for an empty space list", async () => {
    const repos = createExternalConversationRepos({
      externalConversation: { findMany: vi.fn() },
    } as never);
    await expect(repos.listForSpaces(actor, [])).resolves.toEqual([]);
  });

  it("updates policy only inside the actor boundary", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany },
    } as never);
    const policy = {
      teamChatAmbientEnabled: false,
      teamChatRules: null,
      automatedSenderPolicies: {},
    };
    await expect(repos.updatePolicy(actor, "ext-1", policy)).resolves.toEqual(policy);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "ext-1", spaceId: "space-1", userId: "user-1" },
      data: policy,
    });
  });

  it("throws IsolationError when the policy row is missing", async () => {
    const repos = createExternalConversationRepos({
      externalConversation: { updateMany: vi.fn(async () => ({ count: 0 })) },
    } as never);
    await expect(
      repos.updatePolicy(actor, "missing", {
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
      }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
