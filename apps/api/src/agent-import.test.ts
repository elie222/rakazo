import type { Actor, Bot } from "@rakazo/contracts";
import { AgentImportCreateInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { agentImportSetupState, createImportedBot, requestDigest } from "./agent-import.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

/**
 * A Prisma stand-in: writes echo their data with an id and are kept; `findFirst` by id finds
 * a kept row, other reads find nothing.
 */
function fakeDb(): never {
  let next = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_, method: string) =>
          async (args?: { data?: Record<string, unknown>; where?: { id?: unknown } }) => {
            if (method === "findMany") return [];
            if (method === "findFirst" && typeof args?.where?.id === "string") {
              return rows.get(args.where.id) ?? null;
            }
            if (method.startsWith("find")) {
              return method === "findFirstOrThrow" ? { id: `${name}-thread` } : null;
            }
            next += 1;
            const row = {
              id: `${name}-${next}`,
              revision: 1,
              content: "",
              updatedAt: new Date(0),
              ...args?.data,
            };
            rows.set(row.id, row);
            return row;
          },
      },
    );
  return new Proxy({}, { get: (_, name: string) => model(name) }) as never;
}

const bot = { id: "bot-1", threadId: "thread-1", name: "Imported" } as Bot;

function services(overrides: Partial<AgentImportServices>): AgentImportServices {
  const db = fakeDb();
  return {
    prisma: db,
    createBot: async (_actor, input) => {
      await input.seed(db, bot.id);
      return bot;
    },
    hasModelConnection: async () => false,
    connectedProviders: async () => new Set(),
    mcpCredentialValues: async () => null,
    validateBotModel: async () => "Connect that model provider first",
    stdioAllowed: () => false,
    prepareModelKey: async () => ({}),
    writeModelKey: async () => ({ id: "cred-1", secretId: "secret-1", provider: "openrouter" }),
    afterModelKey: () => undefined,
    prepareMcpServer: async () => null,
    insertMcpServer: async () => {
      throw new Error("not used");
    },
    inTransaction: async (run) => run(db),
    findBot: async () => bot,
    assertRoutineSchedule: () => undefined,
    routineNextRunAt: () => null,
    routineRowData: (_actor, input) => ({ ...input }) as never,
    announceRoutine: async () => undefined,
    destroyBot: async () => undefined,
    removeMcpServer: async () => undefined,
    notifyThread: async () => undefined,
    ...overrides,
  };
}

const input = AgentImportCreateInput.parse({
  files: [
    { path: ".hermes/SOUL.md", content: "Direct.\n" },
    { path: ".hermes/.env", content: "OPENROUTER_API_KEY=placeholder-openrouter-key\n" },
    {
      path: ".hermes/cron/jobs.json",
      content: JSON.stringify({
        jobs: [
          {
            id: "a",
            name: "morning",
            prompt: "Summarise my day",
            schedule: { kind: "cron", expr: "0 9 * * *" },
          },
        ],
      }),
    },
  ],
  name: "Imported",
  includeSecrets: true,
  selection: {
    instructions: ["instructions:SOUL.md"],
    memory: [],
    skills: [],
    routines: ["routine:a"],
    apiKeys: ["key:openrouter"],
  },
});

describe("after the import commits", () => {
  it("reports success even when a notice or refresh fails", async () => {
    const announceRoutine = vi.fn(async () => {
      throw new Error("events are down");
    });
    const afterModelKey = vi.fn(() => {
      throw new Error("catalog is down");
    });
    await expect(
      createImportedBot(services({ announceRoutine, afterModelKey }), actor, input),
    ).resolves.toBe(bot);
    expect(announceRoutine).toHaveBeenCalledTimes(1);
    expect(afterModelKey).toHaveBeenCalledWith("openrouter");
  });

  it("records only keys it created, leaving a connection made meanwhile alone", async () => {
    const afterModelKey = vi.fn();
    const writeModelKey = vi.fn(async () => null);
    await expect(
      createImportedBot(services({ afterModelKey, writeModelKey }), actor, input),
    ).resolves.toBe(bot);
    expect(writeModelKey).toHaveBeenCalledTimes(1);
    expect(afterModelKey).not.toHaveBeenCalled();
  });
});

describe("the request digest", () => {
  it("is the same for the same import in another order, and differs for other choices", () => {
    const reordered = {
      ...input,
      files: [...input.files].reverse(),
      selection: {
        ...input.selection,
        instructions: [...input.selection.instructions, "x"].reverse(),
      },
    };
    const extended = {
      ...input,
      selection: { ...input.selection, instructions: [...input.selection.instructions, "x"] },
    };
    expect(requestDigest(reordered)).toBe(requestDigest(extended));
    expect(requestDigest({ ...input, selection: { ...input.selection, routines: [] } })).not.toBe(
      requestDigest(input),
    );
  });
});

describe("an import that committed", () => {
  it("is reported as imported even if its record is removed right after the commit", async () => {
    // The seed commits with the bot that is returned; afterwards its record is gone from
    // what the rest of the app reads (an Undo, say), here a store separate from the seed's.
    const committed = services({
      createBot: async (_actor, request) => {
        await request.seed(fakeDb(), bot.id);
        return bot;
      },
    });
    await expect(createImportedBot(committed, actor, input)).resolves.toBe(bot);
  });
});

describe("an import whose attempt did not commit", () => {
  it("is not reported as imported when a first bot made meanwhile wins", async () => {
    const afterModelKey = vi.fn();
    const announceRoutine = vi.fn(async () => undefined);
    const winner = { id: "chief", threadId: "thread-chief", name: "Chief" } as Bot;
    const attempt = services({
      afterModelKey,
      announceRoutine,
      // The first attempt runs the import and is rolled back (its writes never commit);
      // the retry finds the first bot already made and returns it without the import.
      createBot: async (_actor, request) => {
        await request.seed(fakeDb(), "rolled-back");
        return winner;
      },
    });
    await expect(
      createImportedBot(attempt, actor, { ...input, spawnKey: "onboarding:first" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Nothing that only follows a committed import ran.
    expect(afterModelKey).not.toHaveBeenCalled();
    expect(announceRoutine).not.toHaveBeenCalled();
  });
});

describe("reading an import's setup state", () => {
  it("reads each provider once, in one read of the actor's connections", async () => {
    const connectedProviders = vi.fn(async () => new Set(["openrouter"]));
    const hasModelConnection = vi.fn(async () => true);
    const state = await agentImportSetupState(
      services({ connectedProviders, hasModelConnection }),
      actor,
      {
        botId: "bot-1",
        providers: ["openrouter", "openrouter", "deepseek", "openrouter"],
        serverIds: [],
        routineIds: [],
      },
    );
    expect(state.providers).toEqual({ openrouter: true, deepseek: false });
    expect(connectedProviders).toHaveBeenCalledTimes(1);
    expect(connectedProviders).toHaveBeenCalledWith(actor, ["openrouter", "deepseek"]);
    expect(hasModelConnection).not.toHaveBeenCalled();
  });
});

describe("an imported stdio server's setup state", () => {
  it("cannot be verified when it needs a program, so it is never reported done", async () => {
    const created = {
      mcpServers: [
        { id: "files", revision: 1, credentials: [], env: [], unverifiable: true },
        { id: "docs", revision: 1, credentials: [], env: [] },
      ],
    };
    const prisma = {
      mcpServer: {
        findMany: async () => [
          { id: "files", secretId: null },
          { id: "docs", secretId: null },
        ],
      },
      botMcpServer: { findMany: async () => [{ serverId: "files" }, { serverId: "docs" }] },
      routine: { findMany: async () => [] },
      agentImport: { findMany: async () => [{ created }] },
    };
    const state = await agentImportSetupState(services({ prisma: prisma as never }), actor, {
      botId: "bot-1",
      providers: [],
      serverIds: ["files", "docs"],
      routineIds: [],
    });
    expect(state.serverIds).toEqual({ files: "unverifiable", docs: true });
  });
});

describe("an imported server asked for twice", () => {
  it("is decrypted once", async () => {
    const created = {
      mcpServers: [{ id: "docs", revision: 1, credentials: ["Authorization"], env: [] }],
    };
    const prisma = {
      mcpServer: { findMany: async () => [{ id: "docs", secretId: "secret-docs" }] },
      botMcpServer: { findMany: async () => [{ serverId: "docs" }] },
      routine: { findMany: async () => [] },
      agentImport: { findMany: async () => [{ created }] },
    };
    const mcpCredentialValues = vi.fn(async () => ({
      headers: { Authorization: "Bearer placeholder" },
      env: {},
    }));
    const state = await agentImportSetupState(
      services({ prisma: prisma as never, mcpCredentialValues }),
      actor,
      { botId: "bot-1", providers: [], serverIds: ["docs", "docs", "docs"], routineIds: [] },
    );
    expect(state.serverIds).toEqual({ docs: true });
    expect(mcpCredentialValues).toHaveBeenCalledTimes(1);
  });
});
