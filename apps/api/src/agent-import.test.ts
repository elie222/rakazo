import type { Actor, Bot } from "@rakazo/contracts";
import { AgentImportCreateInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { createImportedBot } from "./agent-import.js";

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
    removeModelConnection: async () => undefined,
    removeMcpServer: async () => undefined,
    ...overrides,
  };
}

const input = AgentImportCreateInput.parse({
  files: [
    { path: ".hermes/SOUL.md", content: "Direct.\n" },
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
  selection: {
    instructions: ["instructions:SOUL.md"],
    memory: [],
    skills: [],
    routines: ["routine:a"],
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
  });
});
