import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};

const baseBot = {
  id: "bot-1",
  spaceId: "ws-1",
  userId: "user-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", unread: false, messages: [] },
  runs: [],
  computer: null,
};

function reposFor(memoryScope: string | null) {
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [{ ...baseBot, memoryScope }]),
    },
    run: {
      findMany: vi.fn(async () => []),
    },
  };
  return createRepos(prisma as unknown as PrismaClient);
}

function peerRun(intent: "request" | "result" = "result") {
  return {
    id: "run-peer",
    sourceMessage: {
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Coder",
          text: intent === "request" ? "Check this." : "Done.",
          intent,
        },
      ],
    },
  };
}

describe("createRepos.listBots", () => {
  it("passes memoryScope through as null when unset", async () => {
    await expect(reposFor(null).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: null }),
    ]);
  });

  it("passes memoryScope through when set to shared", async () => {
    await expect(reposFor("shared").listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: "shared" }),
    ]);
  });

  it("uses a bot's final peer-work summary in sidebar previews", async () => {
    const findMany = vi.fn(async () => [
      {
        ...baseBot,
        thread: {
          ...baseBot.thread,
          messages: [
            {
              runId: "run-peer",
              blocks: [{ kind: "text", text: "Echoed peer reply" }],
            },
            {
              runId: "run-peer",
              blocks: [
                {
                  kind: "bot_message_received",
                  fromBotId: "bot-2",
                  fromBotName: "Coder",
                  text: "Peer result",
                },
              ],
            },
            { runId: "run-user", blocks: [{ kind: "text", text: "Visible answer" }] },
          ],
        },
      },
    ]);
    const prisma = {
      bot: {
        findMany,
      },
      run: {
        findMany: vi.fn(async () => [peerRun()]),
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Echoed peer reply" }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: 16 },
            },
          },
        }),
      }),
    );
  });

  it("prefers the latest peer-report summary over earlier untagged mid-turn narration", async () => {
    const findMany = vi.fn(async () => [
      {
        ...baseBot,
        thread: {
          ...baseBot.thread,
          messages: [
            {
              seq: 3,
              runId: "run-peer",
              blocks: [{ kind: "text", text: "Coder finished the review." }],
            },
            {
              seq: 2,
              runId: "run-peer",
              blocks: [{ kind: "text", text: "Still drafting the report." }],
            },
            { seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Visible answer" }] },
          ],
        },
      },
    ]);
    const prisma = {
      bot: { findMany },
      run: { findMany: vi.fn(async () => [peerRun()]) },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Coder finished the review." }),
    ]);
  });

  it("uses a peer-work summary when the receipt is outside the preview window", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                {
                  runId: "run-peer",
                  blocks: [{ kind: "text", text: "Echoed peer reply" }],
                },
                { runId: "run-user", blocks: [{ kind: "text", text: "Visible answer" }] },
              ],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [peerRun()]),
      },
      message: {
        findMany: vi.fn(async () => []),
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Echoed peer reply" }),
    ]);
  });

  it("keeps an assigned worker's reply out of sidebar previews", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                {
                  runId: "run-peer",
                  blocks: [{ kind: "text", text: "The check passed." }],
                },
                { runId: "run-user", blocks: [{ kind: "text", text: "Older visible answer" }] },
              ],
            },
          },
        ]),
      },
      run: { findMany: vi.fn(async () => [peerRun("request")]) },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
  });

  it("scans older messages when the newest window is only peer output", async () => {
    const messageFindMany = vi.fn(async () => [
      { seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Older visible answer" }] },
    ]);
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                {
                  seq: 20,
                  runId: "run-peer",
                  blocks: [{ kind: "steps", steps: [{ label: "Peer work", count: 1 }] }],
                },
              ],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { lt: 20 } },
      orderBy: { seq: "desc" },
      take: 16,
      select: { seq: true, blocks: true, runId: true, clientNonce: true },
    });
  });

  it("uses a visible message from the fourth older window for preview", async () => {
    const peerWindows = [
      [
        {
          seq: 80,
          runId: "run-peer",
          blocks: [{ kind: "steps", steps: [{ label: "peer 80", count: 1 }] }],
        },
      ],
      [
        {
          seq: 60,
          runId: "run-peer",
          blocks: [{ kind: "steps", steps: [{ label: "peer 60", count: 1 }] }],
        },
      ],
      [
        {
          seq: 40,
          runId: "run-peer",
          blocks: [{ kind: "steps", steps: [{ label: "peer 40", count: 1 }] }],
        },
      ],
      [
        {
          seq: 20,
          runId: "run-peer",
          blocks: [{ kind: "steps", steps: [{ label: "peer 20", count: 1 }] }],
        },
      ],
      [{ seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Fourth-window answer" }] }],
    ];
    let windowIndex = 0;
    const messageFindMany = vi.fn(async () => {
      windowIndex += 1;
      return peerWindows[windowIndex] ?? [];
    });
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: peerWindows[0],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Fourth-window answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledTimes(4);
  });
});

describe("createRepos.listSpaceBotsForSpaces", () => {
  it("loads and maps only the compact cross-space sidebar fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [
            {
              seq: 1,
              runId: null,
              clientNonce: null,
              blocks: [{ kind: "text", text: "Waiting for a reply" }],
            },
          ],
        },
        runs: [{ status: "running" }],
      },
    ]);
    const runFindMany = vi.fn(async () => []);
    const repos = createRepos({
      bot: { findMany },
      run: { findMany: runFindMany },
    } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(actor, ["ws-2"])).resolves.toEqual([
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        unread: true,
        preview: "Waiting for a reply",
        status: "running",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.where).toEqual(
      expect.objectContaining({ spaceId: { in: ["ws-2"] }, userId: actor.userId }),
    );
    expect(query.select).not.toHaveProperty("description");
    expect(query.select).not.toHaveProperty("instructions");
    expect(query.select).not.toHaveProperty("computer");
    expect(query.select.thread).toEqual(
      expect.objectContaining({
        select: expect.objectContaining({
          messages: expect.objectContaining({
            select: { seq: true, blocks: true, runId: true, clientNonce: true },
          }),
        }),
      }),
    );
  });

  it("scans older messages when the newest cross-space window is only peer output", async () => {
    const messageFindMany = vi.fn(async () => [
      {
        seq: 1,
        runId: "run-user",
        clientNonce: null,
        blocks: [{ kind: "text", text: "Older visible answer" }],
      },
    ]);
    const botFindMany = vi.fn(async () => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          id: "thread-2",
          unread: true,
          messages: [
            {
              seq: 20,
              runId: "run-peer",
              clientNonce: null,
              blocks: [{ kind: "steps", steps: [{ label: "Peer work", count: 1 }] }],
            },
          ],
        },
        runs: [],
      },
    ]);
    const repos = createRepos({
      bot: { findMany: botFindMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
      message: { findMany: messageFindMany },
    } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(actor, ["ws-2"])).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { threadId: "thread-2", seq: { lt: 20 } },
      orderBy: { seq: "desc" },
      take: 16,
      select: { seq: true, blocks: true, runId: true, clientNonce: true },
    });
  });

  it("keeps assigned worker replies out of cross-space sidebar previews", async () => {
    const botFindMany = vi.fn(async () => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [
            {
              runId: "run-peer",
              clientNonce: null,
              blocks: [{ kind: "text", text: "Private worker result" }],
            },
            {
              runId: "run-user",
              clientNonce: null,
              blocks: [{ kind: "text", text: "Older visible answer" }],
            },
          ],
        },
        runs: [],
      },
    ]);
    const repos = createRepos({
      bot: { findMany: botFindMany },
      run: { findMany: vi.fn(async () => [peerRun("request")]) },
    } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(actor, ["ws-2"])).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
  });

  it("shows assigned worker takeover requests in cross-space sidebar previews", async () => {
    const botFindMany = vi.fn(async () => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [
            {
              seq: 2,
              runId: "run-peer",
              clientNonce: null,
              blocks: [
                {
                  kind: "computer",
                  state: "Ready",
                  text: "Please complete the staging login.",
                },
              ],
            },
          ],
        },
        runs: [{ status: "waiting_takeover" }],
      },
    ]);
    const repos = createRepos({
      bot: { findMany: botFindMany },
      run: { findMany: vi.fn(async () => [peerRun("request")]) },
    } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(actor, ["ws-2"])).resolves.toEqual([
      expect.objectContaining({
        preview: "Please complete the staging login.",
        status: "waiting_takeover",
      }),
    ]);
  });
});

describe("createRepos.reorderBots", () => {
  function reorderRepos(ids: string[]) {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      bot: {
        findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
        update,
      },
    };
    const prisma = {
      $transaction: vi.fn((run: (client: typeof tx) => Promise<void>) => run(tx)),
    };
    return { repos: createRepos(prisma as unknown as PrismaClient), update };
  }

  it("writes each owned bot's requested position", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await repos.reorderBots(actor, ["bot-2", "bot-1"]);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "bot-2" },
      data: { position: 0 },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "bot-1" },
      data: { position: 1 },
    });
  });

  it("rejects partial or foreign bot lists before writing", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await expect(repos.reorderBots(actor, ["bot-1"])).rejects.toBeInstanceOf(IsolationError);
    await expect(repos.reorderBots(actor, ["bot-1", "foreign"])).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
