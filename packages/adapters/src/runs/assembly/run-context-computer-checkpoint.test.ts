import type { ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { loadRunTurnState, retireIntroTurnCheckpoint } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { namedAgentTools } from "../../runtime/pi/tools/pi-runtime-tools.js";
import { PausedTurnToolsUnavailableError } from "../lifecycle/run-lifecycle.js";
import type { RunContext } from "./run-context.js";
import {
  nextMutatingEffectOccurrence,
  restoreTurnCheckpointEffects,
  seedIntroEffectOccurrences,
} from "./run-context.js";

function fixture(tools: ConnectorTool[] = []) {
  return {
    runId: "run-1",
    tools: { offered: tools },
    state: {
      effects: {
        occurrences: [],
        counts: new Map(),
        consumedIds: new Set(),
        restoredPending: undefined,
      },
    },
  } as unknown as RunContext;
}
const tool = (name: string): ConnectorTool => ({
  name,
  description: "Fixture",
  inputSchema: { type: "object" },
});
const model = { provider: "fixture", id: "main" };
function checkpoint(name: string, mode?: "main" | "computer") {
  return JSON.stringify({
    version: 1,
    provider: model.provider,
    model: model.id,
    systemPrompt: "Fixture",
    pendingToolCallId: "pending",
    executionMode: "sequential",
    computerMode: mode
      ? {
          version: 1,
          mode,
          main: { ...model, auth: "api-key", connectionId: "main-account" },
          computer: { ...model, id: "computer", auth: "api-key", connectionId: "computer-account" },
        }
      : undefined,
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "pending", name, arguments: {} }] },
    ],
  });
}
it.each([
  ["main", "enter_computer_mode"],
  ["computer", "leave_computer_mode"],
] as const)("accepts only the runtime transition for authenticated %s mode", (mode, name) => {
  const blob = checkpoint(name, mode);
  expect(restoreTurnCheckpointEffects(fixture(), blob, model, mode)).toBe(blob);
  expect(restoreTurnCheckpointEffects(fixture(), blob, model)).toBeUndefined();
});
it.each([
  ["main", "leave_computer_mode"],
  ["computer", "enter_computer_mode"],
] as const)("rejects wrong-mode transition in %s", (mode, name) => {
  expect(
    restoreTurnCheckpointEffects(fixture(), checkpoint(name, mode), model, mode),
  ).toBeUndefined();
});
it.each(["enter_computer_mode", "leave_computer_mode"])(
  "does not authorize %s on a legacy checkpoint",
  (name) => {
    expect(restoreTurnCheckpointEffects(fixture(), checkpoint(name), model)).toBeUndefined();
    expect(
      restoreTurnCheckpointEffects(fixture(), checkpoint(name), model, "main"),
    ).toBeUndefined();
  },
);
it.each(["enter_computer_mode", "leave_computer_mode", "leave.computer.mode"])(
  "rejects connector wire-name collisions with %s",
  (name) => {
    expect(
      restoreTurnCheckpointEffects(
        fixture([tool(name)]),
        checkpoint("leave_computer_mode", "computer"),
        model,
        "computer",
      ),
    ).toBeUndefined();
  },
);
it("keeps canonical wire names and saved effect occurrences unchanged", () => {
  const tools = [tool("destination.write"), tool("destination_write")];
  const named = namedAgentTools(tools).find((entry) => entry.tool.name === "destination.write")!;
  const ctx = fixture(tools);
  const saved = JSON.parse(checkpoint(named.name, "computer"));
  const executionId = JSON.stringify(["pi-tool", "main", "pending"]);
  const fingerprint = toolEffectIdempotencyKey("run-1", "destination.write", {});
  saved.effectOccurrences = [{ executionId, fingerprint, occurrence: 3 }];
  const blob = JSON.stringify(saved);
  expect(restoreTurnCheckpointEffects(ctx, blob, model, "computer")).toBe(blob);
  expect(nextMutatingEffectOccurrence(ctx, "destination.write", {}, executionId)).toBe(3);
  expect(nextMutatingEffectOccurrence(ctx, "destination.write", {}, "later")).toBe(4);
  expect(ctx.state.effects.occurrences[0]).toEqual(saved.effectOccurrences[0]);
});
it("retires the intro transcript and gives an identical user tool call a fresh effect key", async () => {
  const intro = fixture();
  const run = { id: intro.runId, spaceId: "space-1" };
  const name = "destination.write";
  const args = { body: "Saved note" };
  const introOccurrence = nextMutatingEffectOccurrence(intro, name, args, "write");
  const introKey = toolEffectIdempotencyKey(run.id, name, args, introOccurrence);
  const receipt = { id: "intro-write", kind: name, idempotencyKey: introKey };
  const ask = JSON.parse(checkpoint("ask_user"));
  ask.messages.unshift(
    { role: "assistant", content: [{ type: "toolCall", id: "write", name, arguments: args }] },
    {
      role: "toolResult",
      toolCallId: "write",
      toolName: name,
      content: [{ type: "text", text: "Saved" }],
    },
  );
  ask.effectOccurrences = intro.state.effects.occurrences;
  const row: { request: unknown; result: unknown } = { request: {}, result: JSON.stringify(ask) };
  const prisma = {
    externalEffect: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([receipt])
        .mockImplementation(async () => [row]),
      upsert: vi.fn(async ({ update }) => Object.assign(row, update)),
    },
  } as unknown as PrismaClient;

  await retireIntroTurnCheckpoint(prisma, run);
  const saved = await loadRunTurnState(prisma, run);
  expect(saved.turnCheckpoint).toBeUndefined();
  const user = fixture();
  seedIntroEffectOccurrences(user.state.effects, run.id, saved.introEffects);
  const userOccurrence = nextMutatingEffectOccurrence(user, name, args, "write");
  expect(introOccurrence).toBe(0);
  expect(userOccurrence).toBe(1);
  expect(toolEffectIdempotencyKey(run.id, name, args, userOccurrence)).not.toBe(introKey);
});

it("reserves the original occurrence when an edited approval replays without a checkpoint", () => {
  const ctx = fixture();
  const toolName = "destination.write";
  const original = { body: "Original" };
  const edited = { body: "Edited" };
  const originalKey = toolEffectIdempotencyKey(ctx.runId, toolName, original, 2);
  expect(nextMutatingEffectOccurrence(ctx, toolName, edited, "approved", originalKey)).toBe(0);
  expect(ctx.state.effects.occurrences[0]).toMatchObject({
    fingerprint: toolEffectIdempotencyKey(ctx.runId, toolName, original),
    occurrence: 2,
  });
  const next = nextMutatingEffectOccurrence(ctx, toolName, original, "later");
  expect(next).toBe(3);
  expect(toolEffectIdempotencyKey(ctx.runId, toolName, original, next)).not.toBe(originalKey);
});

it("reports a pinned turn whose pending tool is offline as unavailable, not incompatible", () => {
  expect(() =>
    restoreTurnCheckpointEffects(
      fixture(),
      checkpoint("desktop_run", "computer"),
      model,
      "computer",
    ),
  ).toThrow(PausedTurnToolsUnavailableError);
  expect(restoreTurnCheckpointEffects(fixture(), checkpoint("desktop_run"), model)).toBeUndefined();
});
