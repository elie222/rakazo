import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet, listSpaceRuns } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

it("attributes historical runs only from their immutable safe profile summary", async () => {
  const snapshot = {
    profileId: "original-profile",
    profileName: "Original profile",
    revision: 2,
    harness: "codex",
    provider: "openai",
    modelId: "original-model",
    credentialLabel: "Original account",
    credentialId: "private-account",
    credentialSecretId: "private-secret",
    spaceId: "private-space",
    userId: "private-user",
    protocol: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    computerId: null,
    runtimeVersion: "0.162.1",
  };
  const findMany = vi.fn(async () => [
    {
      id: "run",
      botId: "bot",
      threadId: "thread",
      status: "completed",
      trigger: "user",
      updatedAt: new Date(0),
      completedAt: new Date(0),
      executionProfileSnapshot: snapshot,
      bot: { name: "Builder", notifyOnFinish: false, executionProfileId: "new-profile" },
      task: { prompt: "work" },
      thread: { groupId: null, group: null },
    },
  ]);
  const rows = await listSpaceRuns(
    { run: { findMany } } as unknown as PrismaClient,
    { userId: "private-user", spaceId: "private-space" } as Actor,
    "recent",
  );
  expect(rows[0]?.executionProfile).toEqual({
    id: "original-profile",
    name: "Original profile",
    revision: 2,
    harness: "codex",
    provider: "openai",
    modelId: "original-model",
    accountLabel: "Original account",
  });
  expect(JSON.stringify(rows)).not.toContain("private-");
  expect(JSON.stringify(rows)).not.toContain("new-profile");
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ userId: "private-user", spaceId: "private-space" }),
    }),
  );
});
