import type { ComputerMode } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export type { ComputerMode } from "@rakazo/contracts";

export function parseComputerMode(scope: string): ComputerMode {
  if (scope === "team" || scope === "dedicated") return scope;
  throw new Error(`Unknown computer scope: ${scope}`);
}

export function computerScopeKey(mode: ComputerMode, workspaceId: string, botId?: string) {
  if (mode === "team") return `team:${workspaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return `bot:${botId}`;
}

export function computerHomeKey(mode: ComputerMode, workspaceId: string, botId?: string) {
  if (mode === "team") return `team-${workspaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return botId;
}

type ComputerDb = Pick<PrismaClient, "computer">;

export async function ensureComputerRecord(
  prisma: ComputerDb,
  input: {
    mode: ComputerMode;
    workspaceId: string;
    userId: string;
    botId?: string;
    kind: string;
  },
) {
  const scopeKey = computerScopeKey(input.mode, input.workspaceId, input.botId);
  return prisma.computer.upsert({
    where: { scopeKey },
    create: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      scope: input.mode,
      scopeKey,
      homeKey: computerHomeKey(input.mode, input.workspaceId, input.botId),
      kind: input.kind,
    },
    update: {},
  });
}
