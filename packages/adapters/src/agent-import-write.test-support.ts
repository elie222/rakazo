import type { Actor, Bot } from "@rakazo/contracts";
import type { AgentImportServices } from "./agent-import-write.js";

export const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

/**
 * A Prisma stand-in: writes echo their data with an id and are kept; `findFirst` by id finds
 * a kept row, other reads find nothing.
 */
export function fakeDb(): never {
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
            // An import is found again by its key.
            if (method === "findFirst" && name === "agentImport") {
              const where = args?.where as Record<string, unknown>;
              return (
                [...rows.values()].find(
                  (row) =>
                    String(row.id).startsWith("agentImport-") && row.importKey === where.importKey,
                ) ?? null
              );
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
  // Raw statements (marking a chat unread for the Space's members) find nothing.
  return new Proxy(
    {},
    { get: (_, name: string) => (name.startsWith("$") ? async () => [] : model(name)) },
  ) as never;
}

export const importedBot = { id: "bot-1", threadId: "thread-1", name: "Imported" } as Bot;

export function fakeImportServices(
  overrides: Partial<AgentImportServices> = {},
): AgentImportServices {
  const db = fakeDb();
  return {
    prisma: db,
    createBot: async (_actor, input) => {
      await input.seed(db, importedBot.id);
      return importedBot;
    },
    hasModelConnection: async () => false,
    connectedProviders: async () => new Set(),
    mcpCredentialValues: async () => null,
    validateBotModel: async () => "Connect that model provider first",
    stdioAllowed: async () => () => false,
    prepareModelKey: async () => ({}),
    writeModelKey: async () => ({ id: "cred-1", secretId: "secret-1", provider: "openrouter" }),
    afterModelKey: () => undefined,
    prepareMcpServer: async () => null,
    insertMcpServer: async () => {
      throw new Error("not used");
    },
    findBot: async () => importedBot,
    routineTriggers: { messageProviders: [], email: false },
    assertRoutineSchedule: () => undefined,
    routineNextRunAt: () => null,
    routineRowData: (_actor, input) => ({ ...input }) as never,
    announceRoutine: async () => undefined,
    notifyThread: async () => undefined,
    ...overrides,
  };
}
