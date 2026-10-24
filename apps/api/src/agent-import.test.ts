import type { Actor, Bot } from "@rakazo/contracts";
import { AgentImportCreateInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { createImportedBot, requestDigest } from "./agent-import.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

/** A Prisma stand-in: reads find nothing, writes echo their data with an id. */
function fakeDb(): never {
  let next = 0;
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, method: string) => async (args?: { data?: Record<string, unknown> }) => {
          if (method === "findMany") return [];
          if (method.startsWith("find")) {
            return method === "findFirstOrThrow" ? { id: `${name}-thread` } : null;
          }
          next += 1;
          return { id: `${name}-${next}`, revision: 1, content: "", ...args?.data };
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
    validateBotModel: async () => "Connect that model provider first",
    stdioAllowed: () => false,
    prepareModelKey: async () => ({}),
    writeModelKey: async () => ({ id: "cred-1", secretId: "secret-1", provider: "openrouter" }),
    afterModelKey: () => undefined,
    prepareMcpServer: async () => null,
    insertMcpServer: async () => {
      throw new Error("not used");
    },
    findBot: async () => bot,
    assertRoutineSchedule: () => undefined,
    routineNextRunAt: () => null,
    routineRowData: (_actor, input) => ({ ...input }) as never,
    announceRoutine: async () => undefined,
    destroyBot: async () => undefined,
    removeMcpServer: async () => undefined,
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
