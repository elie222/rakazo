import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

describe("delegated authorization provenance", () => {
  const request = {
    trigger: "user",
    threadId: "chat",
    delegatedFromRunId: null,
    sourceMessage: {
      role: "user",
      authorUserId: "user",
      threadId: "chat",
      blocks: [{ kind: "text", text: "Compare the documents." }],
    },
  };
  function loaders(trigger: string, origin: string | null, rows: unknown[]) {
    const findFirst = vi.fn();
    for (const row of rows) findFirst.mockResolvedValueOnce(row);
    const trust = createRunTrustLoaders(
      {
        prisma: { run: { findFirst }, message: { findMany: vi.fn(async () => []) } },
      } as unknown as ExecutorDeps,
      {
        run: { userId: "user", spaceId: "space", trigger, delegatedFromRunId: origin },
        runId: "run",
        botId: "bot",
        taskPrompt: "Model-generated brief and instructions",
        ownerStartedRun: true,
        messagingChannelRun: false,
        sourceMessage: null,
        connectedPlugins: [],
      },
    );
    return { trust, findFirst };
  }
  it("recovers the initiating user's words for a helper result across restart", async () => {
    const { trust, findFirst } = loaders("helper_result", "helper", [
      { trigger: "helper", delegatedFromRunId: "parent" },
      request,
    ]);
    expect(await trust.loadOwnerWords()).toBe("Compare the documents.");
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "parent", userId: "user", spaceId: "space", botId: "bot" },
      }),
    );
  });
  it.each([
    null,
    { ...request, status: "cancelled" },
    {
      ...request,
      thread: { groupId: "group", group: { archivedAt: new Date(), members: [{ botId: "bot" }] } },
    },
    { ...request, thread: { groupId: "group", group: { archivedAt: null, members: [] } } },
    { ...request, sourceMessage: null },
    { ...request, sourceMessage: { ...request.sourceMessage, authorUserId: "another-user" } },
    { ...request, sourceMessage: { ...request.sourceMessage, role: "bot" } },
    { ...request, sourceMessage: { ...request.sourceMessage, threadId: "another-chat" } },
  ])("does not treat missing, foreign, or generated messages as permission", async (row) => {
    const { trust } = loaders("helper", "parent", [row]);
    expect(await trust.loadOwnerWords()).toBe("");
  });
  it("does not substitute the brief for helpers created by the previous release", async () => {
    const { trust, findFirst } = loaders("helper", null, []);
    expect(await trust.loadOwnerWords()).toBe("");
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("the owner's earlier messages", () => {
  const blocks = (text: string) => [{ kind: "text", text }];
  function loaders(input: {
    source?: { id: string; role: string; blocks: unknown } | null;
    ownerStartedRun?: boolean;
    messagingChannelRun?: boolean;
    trigger?: string;
    sourceRow?: { seq: number; threadId: string; authorUserId: string | null } | null;
    rows?: Array<{ id: string; blocks: unknown }>;
  }) {
    const findMany = vi.fn(async () => input.rows ?? []);
    const findUnique = vi.fn(async () => input.sourceRow ?? null);
    const trust = createRunTrustLoaders(
      { prisma: { message: { findMany, findUnique } } } as unknown as ExecutorDeps,
      {
        run: {
          userId: "owner",
          spaceId: "space",
          trigger: input.trigger ?? "user",
          threadId: "chat",
        },
        runId: "run",
        botId: "bot",
        taskPrompt: "yes",
        ownerStartedRun: input.ownerStartedRun ?? true,
        messagingChannelRun: input.messagingChannelRun ?? false,
        sourceMessage:
          input.source === undefined
            ? { id: "m9", role: "user", blocks: blocks("yes") }
            : input.source,
        connectedPlugins: [],
      },
    );
    return { trust, findMany };
  }

  it("reads the owner's own messages before this one, oldest first", async () => {
    const { trust, findMany } = loaders({
      sourceRow: { seq: 9, threadId: "chat", authorUserId: "owner" },
      // Newest first, as the query orders them.
      rows: [
        { id: "m7", blocks: blocks("Refund order 1182 for $40") },
        { id: "m5", blocks: [{ kind: "image", url: "x" }] },
        { id: "m3", blocks: blocks("Morning") },
      ],
    });
    expect(await trust.loadEarlierOwnerMessages()).toEqual([
      "Morning",
      "Refund order 1182 for $40",
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "chat", role: "user", authorUserId: "owner", seq: { lt: 9 } },
        take: 3,
      }),
    );
  });

  it("reads nothing for a run the owner's own chat message did not start", async () => {
    const sourceRow = { seq: 9, threadId: "chat", authorUserId: "owner" };
    for (const input of [
      { ownerStartedRun: false, sourceRow },
      { messagingChannelRun: true, sourceRow },
      { trigger: "helper_result", sourceRow },
      { source: null, sourceRow },
      { sourceRow: { ...sourceRow, authorUserId: "member" } },
      { sourceRow: { ...sourceRow, threadId: "other" } },
    ]) {
      const { trust, findMany } = loaders({ ...input, rows: [{ id: "m1", blocks: blocks("x") }] });
      expect(await trust.loadEarlierOwnerMessages()).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    }
  });
});
