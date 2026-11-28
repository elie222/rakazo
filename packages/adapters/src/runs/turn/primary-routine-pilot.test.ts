import { createHash } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { routineTimerNonce } from "../../routines/routine-coalescing.js";
import {
  assertPrimaryRoutineRuntimePin,
  pilotRoutineModel,
  pilotRoutineRequest,
  routinePilotEnrollment,
  usesNativeRoutineAdmission,
} from "./primary-routine-pilot.js";

const prompt = "Summarize this text: hidden-token";
const digest = createHash("sha256").update(prompt).digest("hex");
const routineId = "routine-1";
const userId = "owner";
const spaceId = "space";
const botId = "bot-1";
const threadId = "dm";
const bot = {
  id: botId,
  userId,
  spaceId,
  archivedAt: null,
  primaryRuntimePreference: null,
  primaryRuntimeRevision: 2,
  modelProvider: "anthropic",
  modelId: "test-model",
  modelCredentialId: "named-key",
  thread: { id: threadId, userId, spaceId, botId, groupId: null, externalConversationId: null },
};
const routine = {
  id: routineId,
  botId,
  userId,
  spaceId,
  threadId,
  active: true,
  prompt,
  crons: ["0 10 * * *"],
  inChat: false,
  computerPromptHash: null,
  watch: null,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  bot,
};
const pin = {
  primaryRuntime: "claude-agent",
  primaryRuntimeRevision: bot.primaryRuntimeRevision,
  modelId: bot.modelId,
  modelProvider: bot.modelProvider,
  modelCredentialId: bot.modelCredentialId,
  modelPinned: true,
};
const run = {
  id: "run-a",
  botId,
  userId,
  spaceId,
  threadId,
  trigger: "routine",
  routineId,
  clientNonce: routineTimerNonce(routineId, "2026-01-01T10:00:00.000Z"),
  sourceMessageId: null,
  retryOfRunId: null,
  ...pin,
};
const model = { provider: bot.modelProvider, id: bot.modelId, connectionId: bot.modelCredentialId };
const prisma = (current: unknown = routine, deactivatedAt: Date | null = null) => ({
  routine: { findFirst: vi.fn().mockResolvedValue(current) },
  user: { findUnique: vi.fn().mockResolvedValue({ deactivatedAt }) },
});
function request(
  db: ReturnType<typeof prisma>,
  data: Parameters<typeof pilotRoutineRequest>[1] = run,
) {
  return pilotRoutineRequest(db as unknown as PrismaClient, data, prompt, model, undefined, [
    "hidden-token",
  ]);
}

beforeEach(() => {
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", botId);
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", process.execPath);
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_ROUTINES", `${routineId}:${digest}`);
});
afterEach(() => vi.unstubAllEnvs());

it("is off by default and refuses ambiguous explicit enrolments", () => {
  expect(routinePilotEnrollment(routineId, {})).toBeUndefined();
  expect(routinePilotEnrollment("another-routine")).toBeUndefined();
  expect(
    routinePilotEnrollment(routineId, {
      PRIMARY_RUNTIME_PILOT_ROUTINES: `${routineId}:${digest},${routineId}:${digest}`,
    }),
  ).toEqual({ digest: undefined });
  if (process.platform === "linux")
    expect(pilotRoutineModel(routine, threadId, routinePilotEnrollment(routineId))).toEqual(pin);
});

it("honors explicit Pi, inherits only configured timers, and sends explicit native through refusal if unenrolled", () => {
  expect(usesNativeRoutineAdmission(bot, undefined)).toBe(false);
  expect(usesNativeRoutineAdmission(bot, { digest })).toBe(true);
  expect(usesNativeRoutineAdmission({ primaryRuntimePreference: "pi" }, { digest })).toBe(false);
  expect(usesNativeRoutineAdmission({ primaryRuntimePreference: "claude-agent" }, undefined)).toBe(
    true,
  );
});

it.skipIf(process.platform !== "linux")("fences a queued routine before model setup", () => {
  expect(() => assertPrimaryRoutineRuntimePin(run, bot)).not.toThrow();
  expect(() => assertPrimaryRoutineRuntimePin(run, { ...bot, primaryRuntimeRevision: 4 })).toThrow(
    "has changed",
  );
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", "");
  expect(() => assertPrimaryRoutineRuntimePin(run, bot)).toThrow("unavailable");
});

it.each([
  { active: false },
  { userId: "another-owner" },
  { computerPromptHash: "a-computer-grant" },
  { threadId: "group" },
  { inChat: true },
  { watch: { kind: "web" } },
  { webhookEnabled: true },
  { githubEnabled: true },
  { emailSenders: "owner" },
  { messageProvider: "slack" },
  { modelId: "another-model" },
  { prompt: "Edited instructions" },
])("does not pin the runtime for an ineligible routine (%j)", (change) => {
  expect(
    pilotRoutineModel({ ...routine, ...change }, threadId, routinePilotEnrollment(routineId)),
  ).toBeUndefined();
});

it.skipIf(process.platform !== "linux")(
  "reads the exact live authorized routine and projects only its redacted text",
  async () => {
    const db = prisma();
    const result = await request(db);
    expect(db.routine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: routineId,
          botId,
          userId,
          spaceId,
          space: { deletingAt: null, memberships: { some: { userId } } },
        },
      }),
    );
    expect(result).toMatchObject({
      botId,
      threadId,
      model,
      sourceMessageId: null,
      history: [],
      tools: [],
      instructions: "",
    });
    expect(result.prompt).toContain("Summarize this text:");
    expect(result.prompt).not.toContain("hidden-token");
    expect(result).not.toHaveProperty("secrets");
  },
);

it.each([
  null,
  { ...routine, active: false },
  { ...routine, prompt: "Edited" },
  { ...routine, bot: { ...bot, modelCredentialId: "changed-key" } },
  { ...routine, bot: { ...bot, primaryRuntimeRevision: 4 } },
  { ...routine, bot: { ...bot, archivedAt: new Date(0) } },
])("refuses to launch after the authorized routine or account changes", async (current) => {
  await expect(request(prisma(current))).rejects.toThrow("no longer authorized");
});

it("refuses launch for a disabled account or removed enrollment", async () => {
  await expect(request(prisma(routine, new Date(0)))).rejects.toThrow("no longer authorized");
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_ROUTINES", "");
  await expect(request(prisma())).rejects.toThrow("no longer authorized");
});

it.each([
  { clientNonce: null },
  { clientNonce: routineTimerNonce("other-routine", "2026-01-01T10:00:00.000Z") },
  { retryOfRunId: "previous" },
  { sourceMessageId: "webhook" },
])("never accepts an event, a retry, or unproven scheduler provenance (%j)", async (change) => {
  const db = prisma();
  await expect(request(db, { ...run, ...change })).rejects.toThrow("no longer authorized");
  expect(db.routine.findFirst).not.toHaveBeenCalled();
});
