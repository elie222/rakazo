import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { loadRunTurnState, retireIntroTurnCheckpoint } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import {
  MAX_OUTSIDE_TEXT_CHARS,
  outsideOnlyTargets,
} from "../../approvals/review-target-sources.js";
import { selectContext, shortenToolResultText } from "../../runtime/context/context-selection.js";
import type { WatchDeliveryState } from "../../runtime/context/runtime-context.js";
import { createRuntimeContextPolicy } from "../../runtime/context/runtime-context.js";
import { OMITTED_AFTER_USE } from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import type { ToolHost } from "../../runtime/pi/tools/pi-runtime-tools.js";
import {
  createQueue,
  namedAgentTools,
  serializeToolResult,
  toAgentTools,
} from "../../runtime/pi/tools/pi-runtime-tools.js";
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

function checkpointWithRoutineRead(
  toolName: "schedule_list" | "task_catalog",
  id: string,
  text: string,
  details?: unknown,
) {
  const saved = JSON.parse(checkpoint("ask_user"));
  saved.messages.unshift(
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName,
      content: [{ type: "text", text }],
      ...(details !== undefined ? { details } : {}),
    },
  );
  return JSON.stringify(saved);
}

it.each(["schedule_list", "task_catalog"] as const)(
  "restores stored watch check text and entry keys from saved %s tool results",
  (toolName) => {
    const saved = checkpointWithRoutineRead(
      toolName,
      "read-1",
      JSON.stringify({
        routines: [
          {
            routineId: "r-1",
            prompt: "Owner private prompt",
            lastCheck: {
              checkedAt: "2026-11-25T07:00:00.000Z",
              outcome: "changed",
              fingerprint: "fp-1",
              entries: {
                "alice@example.com": 'item:{"fields":["\\"open\\""],"title":"Invoice"}',
              },
              detail: "1 new item",
            },
          },
        ],
      }),
    );
    const ctx = fixture([tool("ask_user")]);
    ctx.state.outsideText = "";
    expect(restoreTurnCheckpointEffects(ctx, saved, model)).toBeDefined();
    expect(ctx.state.outsideText).toContain("alice@example.com");
    expect(ctx.state.outsideText).toContain("invoice");
    expect(ctx.state.outsideText).not.toContain("owner private prompt");
  },
);

it("leaves outsideText empty when saved routine-read checkpoints have no watch checks", () => {
  for (const toolName of ["schedule_list", "task_catalog"] as const) {
    const clean = checkpointWithRoutineRead(
      toolName,
      "read-clean",
      JSON.stringify({
        routines: [{ routineId: "r-2", prompt: "Owner private prompt", lastCheck: null }],
      }),
    );
    const ctx = fixture([tool("ask_user")]);
    ctx.state.outsideText = "";
    expect(restoreTurnCheckpointEffects(ctx, clean, model)).toBeDefined();
    expect(ctx.state.outsideText).toBe("");
  }
});

it("falls back to raw text when a saved routine-read result was truncated mid-JSON", () => {
  const truncated = checkpointWithRoutineRead(
    "schedule_list",
    "read-truncated",
    '{"routines":[{"lastCheck":{"entries":{"bob@example.com":"truncated...',
  );
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, truncated, model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("bob@example.com");
});

it("prefers structured details over clipped routine-read text without leaking owner prompts", () => {
  const clippedClean = checkpointWithRoutineRead(
    "schedule_list",
    "read-clipped-clean",
    '{"routines":[{"routineId":"r-0","prompt":"Email owner@example.com"...[clipped]',
    {
      routines: Array.from({ length: 50 }, (_, index) => ({
        routineId: `r-${index}`,
        prompt: "Email owner@example.com with the weekly report",
      })),
    },
  );
  const cleanCtx = fixture([tool("ask_user")]);
  cleanCtx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(cleanCtx, clippedClean, model)).toBeDefined();
  expect(cleanCtx.state.outsideText).toBe("");

  const clippedWatch = checkpointWithRoutineRead(
    "task_catalog",
    "read-clipped-watch",
    '{"routines":[{"routineId":"r-0","prompt":"Email owner@example.com"...[clipped]',
    {
      routines: [
        { routineId: "r-0", prompt: "Email owner@example.com" },
        {
          routineId: "r-watch",
          prompt: "Check alerts",
          lastCheck: {
            checkedAt: "2026-11-25T07:00:00.000Z",
            outcome: "changed",
            fingerprint: "fp-2",
            entries: { "carol@example.com": 'item:{"fields":["\\"new\\""],"title":"Alert"}' },
            detail: null,
          },
        },
      ],
    },
  );
  const watchCtx = fixture([tool("ask_user")]);
  watchCtx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(watchCtx, clippedWatch, model)).toBeDefined();
  expect(watchCtx.state.outsideText).toContain("carol@example.com");
  expect(watchCtx.state.outsideText).not.toContain("owner@example.com");
});

it("preserves head, tail, and entry keys when restoring a large clipped watch snapshot", () => {
  const hugeWatch = checkpointWithRoutineRead(
    "schedule_list",
    "read-huge",
    '{"routines":[{"routineId":"r-huge","lastCheck":{"detail":"Send to dave@example.com","entries":{"k0":"padding..."...[clipped]',
    {
      routines: [
        {
          routineId: "r-huge",
          prompt: "Check inbox",
          lastCheck: {
            checkedAt: "2026-11-25T07:00:00.000Z",
            outcome: "changed",
            fingerprint: "fp-huge",
            detail: "Send to dave@example.com",
            entries: {
              "early@example.com": `item:${"x".repeat(Math.floor(MAX_OUTSIDE_TEXT_CHARS * 0.65))}`,
              "mid-key@example.com": "item:forward to middle@example.com",
              "late@example.com": `item:${"y".repeat(Math.floor(MAX_OUTSIDE_TEXT_CHARS * 0.65))} send to erin@example.com`,
            },
          },
        },
      ],
    },
  );
  const hugeCtx = fixture([tool("ask_user")]);
  hugeCtx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(hugeCtx, hugeWatch, model)).toBeDefined();
  expect(
    outsideOnlyTargets(
      {
        to: [
          "dave@example.com",
          "early@example.com",
          "middle@example.com",
          "mid-key@example.com",
          "erin@example.com",
          "late@example.com",
        ],
      },
      { ownerWords: ["Check my schedules"], outsideText: hugeCtx.state.outsideText },
    ),
  ).toEqual([
    "dave@example.com",
    "early@example.com",
    "middle@example.com",
    "mid-key@example.com",
    "erin@example.com",
    "late@example.com",
  ]);
});

it("extracts structured watch checks and excludes owner prompts for deferred use_tool task_catalog results", () => {
  const cleanViaUseTool = JSON.parse(checkpoint("ask_user"));
  cleanViaUseTool.messages.unshift(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "use-1",
          name: "use_tool",
          arguments: { name: "task_catalog", arguments: {} },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "use-1",
      toolName: "use_tool",
      content: [
        {
          type: "text",
          text: '{"routines":[{"routineId":"r-0","prompt":"Email owner@example.com"...[clipped]',
        },
      ],
      details: {
        routines: [{ routineId: "r-0", prompt: "Email owner@example.com with weekly summary" }],
      },
    },
  );
  const cleanCtx = fixture([tool("ask_user")]);
  cleanCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(cleanCtx, JSON.stringify(cleanViaUseTool), model),
  ).toBeDefined();
  expect(cleanCtx.state.outsideText).toBe("");

  const watchViaUseTool = JSON.parse(checkpoint("ask_user"));
  watchViaUseTool.messages.unshift(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "use-2",
          name: "use_tool",
          arguments: { name: "task_catalog", arguments: {} },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "use-2",
      toolName: "use_tool",
      content: [
        {
          type: "text",
          text: '{"routines":[{"routineId":"r-0","prompt":"Email owner@example.com"...[clipped]',
        },
      ],
      details: {
        routines: [
          { routineId: "r-0", prompt: "Email owner@example.com" },
          {
            routineId: "r-watch",
            prompt: "Watch inbox",
            lastCheck: {
              checkedAt: "2026-11-25T07:00:00.000Z",
              outcome: "changed",
              fingerprint: "fp-use",
              entries: {
                "first@example.com": `rakazo:item:${"x".repeat(Math.floor(MAX_OUTSIDE_TEXT_CHARS * 0.65))}`,
                "middle@example.com": "rakazo:item:ping target@example.com",
                "last@example.com": `rakazo:item:${"y".repeat(Math.floor(MAX_OUTSIDE_TEXT_CHARS * 0.65))}`,
              },
              detail: null,
            },
          },
        ],
      },
    },
  );
  const watchCtx = fixture([tool("ask_user")]);
  watchCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(watchCtx, JSON.stringify(watchViaUseTool), model),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["middle@example.com", "target@example.com", "owner@example.com"] },
      { ownerWords: ["Check catalog"], outsideText: watchCtx.state.outsideText },
    ),
  ).toEqual(["middle@example.com", "target@example.com"]);

  // A reused call ID in a later wrapped tool call must not overwrite an earlier task_catalog mapping.
  const reusedIdCheckpoint = JSON.parse(checkpoint("ask_user"));
  reusedIdCheckpoint.messages.unshift(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "shared-id",
          name: "use_tool",
          arguments: { name: "task_catalog", arguments: {} },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "shared-id",
      toolName: "use_tool",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            routines: [{ routineId: "r-0", prompt: "Email owner@example.test", lastCheck: null }],
          }),
        },
      ],
      details: {
        routines: [{ routineId: "r-0", prompt: "Email owner@example.test", lastCheck: null }],
      },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "shared-id",
          name: "use_tool",
          arguments: { name: "scratchpad_list", arguments: {} },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "shared-id",
      toolName: "use_tool",
      content: [{ type: "text", text: JSON.stringify({ items: [] }) }],
    },
  );
  const reusedCtx = fixture([tool("ask_user")]);
  reusedCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(reusedCtx, JSON.stringify(reusedIdCheckpoint), model),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["owner@example.test"] },
      { ownerWords: ["Check catalog"], outsideText: reusedCtx.state.outsideText },
    ),
  ).toEqual([]);
});

it("restores saved watch-check targets across context strategy switches and after-use compaction", () => {
  const details = {
    routines: [
      {
        routineId: "r-watch",
        prompt: "Watch inbox",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "changed",
          fingerprint: "fp-switch",
          entries: {
            "item-1": `${"a".repeat(8_000)} current-only@example.test ${"b".repeat(15_000)} tail@example.test`,
          },
          detail: null,
        },
      },
    ],
  };
  const currentDelivered = clipToolResultText(
    serializeToolResult(details, "current", "schedule_list", {}),
  );
  expect(currentDelivered).toContain("current-only@example.test");
  const currentSavedCheckpoint = JSON.parse(checkpoint("ask_user"));
  currentSavedCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "switch-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: currentDelivered }],
    details,
  });
  const defaultResumingCtx = fixture([tool("ask_user")]);
  defaultResumingCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(defaultResumingCtx, JSON.stringify(currentSavedCheckpoint), model),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["current-only@example.test"] },
      { ownerWords: ["List schedules"], outsideText: defaultResumingCtx.state.outsideText },
    ),
  ).toEqual(["current-only@example.test"]);

  const shortenedDelivered = clipToolResultText(
    serializeToolResult(details, undefined, "schedule_list", {}),
  );
  expect(shortenedDelivered).toContain("tail@example.test");
  const shortenedSavedCheckpoint = JSON.parse(checkpoint("ask_user"));
  shortenedSavedCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "switch-2",
    toolName: "schedule_list",
    content: [{ type: "text", text: shortenedDelivered }],
    details,
  });
  const currentResumingCtx = fixture([tool("ask_user")]);
  currentResumingCtx.deps = { contextStrategy: "current" } as never;
  currentResumingCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(
      currentResumingCtx,
      JSON.stringify(shortenedSavedCheckpoint),
      model,
    ),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["tail@example.test"] },
      { ownerWords: ["List schedules"], outsideText: currentResumingCtx.state.outsideText },
    ),
  ).toEqual(["tail@example.test"]);

  // A result compacted again after use (e.g. under retrieval) still restores structured evidence under "current".
  const compactedAfterUse = shortenToolResultText(
    shortenedDelivered,
    1_024,
    { name: "schedule_list" },
    { afterUse: true },
  );
  expect(compactedAfterUse).toContain("tail@example.test");
  const compactedCheckpoint = JSON.parse(checkpoint("ask_user"));
  compactedCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "switch-3",
    toolName: "schedule_list",
    content: [{ type: "text", text: compactedAfterUse }],
    details,
  });
  const compactedResumingCtx = fixture([tool("ask_user")]);
  compactedResumingCtx.deps = { contextStrategy: "current" } as never;
  compactedResumingCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(compactedResumingCtx, JSON.stringify(compactedCheckpoint), model),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["tail@example.test"] },
      { ownerWords: ["List schedules"], outsideText: compactedResumingCtx.state.outsideText },
    ),
  ).toEqual(["tail@example.test"]);
});

it("keeps literal backslashes in a shortened watch item title when shortening removes the title separator", () => {
  const literalTitleItem = `item:${JSON.stringify({
    fields: [JSON.stringify(`prefix ${"f".repeat(12_000)}`)],
    title: "Order \\nbugs@corp.com",
  })}`;
  const entriesWithLongFields: Record<string, string> = {
    "long-watch": literalTitleItem,
  };
  for (let i = 0; i < 400; i += 1) {
    entriesWithLongFields[`entry-${i}@example.test`] = `short-${i}`;
  }
  const separatorDropDetails = {
    routines: [
      {
        routineId: "r-sep-drop",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "changed",
          fingerprint: "fp-sep-drop",
          entries: entriesWithLongFields,
        },
      },
    ],
  };
  const sepDropDelivered = clipToolResultText(
    serializeToolResult(separatorDropDetails, undefined, "schedule_list", {}),
  );
  expect(sepDropDelivered).not.toContain('\\"title\\":');
  expect(sepDropDelivered).toContain("nbugs@corp.com");
  const sepDropCheckpoint = JSON.parse(checkpoint("ask_user"));
  sepDropCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "sep-drop-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: sepDropDelivered }],
    details: separatorDropDetails,
  });
  const sepDropCtx = fixture([tool("ask_user")]);
  sepDropCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(sepDropCtx, JSON.stringify(sepDropCheckpoint), model),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["nbugs@corp.com"] },
      { ownerWords: ["List schedules"], outsideText: sepDropCtx.state.outsideText },
    ),
  ).toEqual(["nbugs@corp.com"]);
});

it("keeps original watch strategy evidence after plain-text after-use compaction across strategy switches", () => {
  const clippedDefaultEntries: Record<string, string> = {
    "head-leaf": `item:${JSON.stringify({
      fields: [JSON.stringify(`head@example.test ${"a".repeat(20_000)}`)],
      title: "Head leaf",
    })}`,
  };
  for (let i = 0; i < 400; i += 1) {
    clippedDefaultEntries[`short-${i}@example.test`] = `val-${i}`;
  }
  const plainCompactDetails = {
    routines: [
      {
        routineId: "r-plain-compact",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          outcome: "changed",
          fingerprint: "fp-plain-compact",
          entries: clippedDefaultEntries,
        },
      },
    ],
  };
  const clippedDefaultDelivered = clipToolResultText(
    serializeToolResult(plainCompactDetails, undefined, "schedule_list", {}),
  );
  expect(() => JSON.parse(clippedDefaultDelivered)).toThrow();
  expect(clippedDefaultDelivered).toContain("short-150@example.test");
  const plainCompactedDefault = shortenToolResultText(
    clippedDefaultDelivered,
    2_048,
    { name: "schedule_list" },
    { afterUse: true },
  );
  const plainDefaultCheckpoint = JSON.parse(checkpoint("ask_user"));
  plainDefaultCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "plain-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: plainCompactedDefault }],
    details: plainCompactDetails,
  });
  const plainDefaultToCurrentCtx = fixture([tool("ask_user")]);
  plainDefaultToCurrentCtx.deps = { contextStrategy: "current" } as never;
  plainDefaultToCurrentCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(
      plainDefaultToCurrentCtx,
      JSON.stringify(plainDefaultCheckpoint),
      model,
    ),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["short-150@example.test"] },
      { ownerWords: ["List schedules"], outsideText: plainDefaultToCurrentCtx.state.outsideText },
    ),
  ).toEqual(["short-150@example.test"]);

  const clippedCurrentDelivered = clipToolResultText(
    serializeToolResult(plainCompactDetails, "current", "schedule_list", {}),
  );
  expect(clippedCurrentDelivered).toContain("head@example.test");
  const plainCompactedCurrent = shortenToolResultText(
    clippedCurrentDelivered,
    2_048,
    { name: "schedule_list" },
    { afterUse: true },
  );
  const plainCurrentCheckpoint = JSON.parse(checkpoint("ask_user"));
  plainCurrentCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "plain-2",
    toolName: "schedule_list",
    content: [{ type: "text", text: plainCompactedCurrent }],
    details: plainCompactDetails,
  });
  const plainCurrentToDefaultCtx = fixture([tool("ask_user")]);
  plainCurrentToDefaultCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(
      plainCurrentToDefaultCtx,
      JSON.stringify(plainCurrentCheckpoint),
      model,
    ),
  ).toBeDefined();
  expect(
    outsideOnlyTargets(
      { to: ["head@example.test"] },
      { ownerWords: ["List schedules"], outsideText: plainCurrentToDefaultCtx.state.outsideText },
    ),
  ).toEqual(["head@example.test"]);
});

it("restores deeply nested watch fields and matches Pi clipped and compacted delivery in checkpoints", async () => {
  const deepPayload = JSON.stringify({
    a: {
      b: {
        c: {
          d: { e: { f: { g: { h: { i: { j: { contact: "deep-checkpoint@outside.test" } } } } } } },
        },
      },
    },
  });
  const deepDetails = {
    routines: [
      {
        routineId: "r-deep",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          entries: {
            "item-deep": `item:${JSON.stringify({ fields: [deepPayload] })}`,
          },
        },
      },
    ],
  };
  const deepCheckpoint = JSON.parse(checkpoint("ask_user"));
  deepCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "deep-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(deepDetails) }],
    details: deepDetails,
  });
  const deepCtx = fixture([tool("ask_user")]);
  deepCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(deepCtx, JSON.stringify(deepCheckpoint), model),
  ).toBeDefined();
  expect(deepCtx.state.outsideText).toContain("deep-checkpoint@outside.test");

  const entries: Record<string, string> = {};
  for (let i = 0; i < 500; i += 1) {
    entries[`item-${String(i).padStart(3, "0")}`] =
      i === 0
        ? 'item:{"fields":["\\"notify checkpoint-entry-000@outside.test\\""]}'
        : i === 499
          ? 'item:{"fields":["\\"notify checkpoint-entry-500@outside.test\\""]}'
          : `item:{"fields":["\\"short tracked entry number ${i} padding\\""]}`;
  }
  const clippedPayload = { routines: [{ routineId: "r-many", lastCheck: { entries } }] };
  const runViaPi = async (resultPayload: unknown) => {
    const host = {
      queue: createQueue(),
      request: {
        runId: "run-1",
        executeTool: async () => resultPayload,
      },
      toolCallBudget: { count: 0, exceeded: false, limit: 0, inFlight: 0 },
      toolCallSeq: { value: 0 },
      providerToolCallIds: new Map(),
      abortTurn: () => undefined,
      signal: new AbortController().signal,
      pausePending: false,
      pendingShells: [],
    } as unknown as ToolHost;
    const [scheduleListTool] = toAgentTools(
      [{ name: "schedule_list", description: "List routines", inputSchema: { type: "object" } }],
      host,
    );
    return scheduleListTool!.execute("c1", {});
  };

  const clippedResult = await runViaPi(clippedPayload);
  const clippedText = (clippedResult.content[0] as { text: string }).text;
  expect(clippedText).toContain("checkpoint-entry-000@outside.test");
  expect(clippedText).not.toContain("checkpoint-entry-500@outside.test");
  const clippedCheckpoint = JSON.parse(checkpoint("ask_user"));
  clippedCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "clipped-1",
    toolName: "schedule_list",
    content: clippedResult.content,
    details: clippedResult.details,
  });
  const clippedCtx = fixture([tool("ask_user")]);
  clippedCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(clippedCtx, JSON.stringify(clippedCheckpoint), model),
  ).toBeDefined();
  expect(clippedCtx.state.outsideText).toContain("checkpoint-entry-000@outside.test");
  expect(clippedCtx.state.outsideText).not.toContain("checkpoint-entry-500@outside.test");

  const largeStructuredPayload = {
    routines: [
      {
        routineId: "r-large-structured",
        lastCheck: {
          detail: `${"d".repeat(TOOL_RESULT_TEXT_LIMIT + 500)} tail-marker`,
          entries: {
            "item-001": `item:${JSON.stringify({
              fields: [`"${"x".repeat(400)} buried-entry@outside.test ${"y".repeat(400)}"`],
            })}`,
          },
        },
      },
    ],
  };
  const structuredDelivered = await runViaPi(largeStructuredPayload);
  const structuredText = (structuredDelivered.content[0] as { text: string }).text;
  expect(structuredText).toContain("buried-entry@outside.test");
  const structuredCompacted = shortenToolResultText(
    structuredText,
    400,
    { name: "schedule_list", arguments: {} },
    { afterUse: true },
  );
  expect(structuredCompacted).toContain(OMITTED_AFTER_USE);
  expect(() => JSON.parse(structuredCompacted)).not.toThrow();
  expect(structuredCompacted).not.toContain("buried-entry@outside.test");
  const compactedCheckpoint = JSON.parse(checkpoint("ask_user"));
  compactedCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "compacted-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: structuredCompacted }],
    details: structuredDelivered.details,
  });
  const compactedCtx = fixture([tool("ask_user")]);
  compactedCtx.deps = { contextStrategy: "current" } as never;
  compactedCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(compactedCtx, JSON.stringify(compactedCheckpoint), model),
  ).toBeDefined();
  expect(compactedCtx.state.outsideText).toContain("buried-entry@outside.test");
});

it("does not restore watch targets omitted before first use, while still recovering after-use cuts", () => {
  const shortDetails = {
    routines: [
      {
        routineId: "r-short",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(350)} never-seen@outside.test ${"b".repeat(350)}`,
        },
      },
    ],
  };
  const raw = JSON.stringify(shortDetails);
  expect(raw.length).toBeLessThan(TOOL_RESULT_TEXT_LIMIT);

  const beforeUseText = shortenToolResultText(
    raw,
    260,
    { name: "schedule_list" },
    { afterUse: false },
  );
  expect(beforeUseText).not.toContain("never-seen@outside.test");
  expect(beforeUseText).not.toContain(OMITTED_AFTER_USE);
  const beforeUseCheckpoint = JSON.parse(checkpoint("ask_user"));
  beforeUseCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "before-use-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: beforeUseText }],
    details: shortDetails,
  });
  const beforeUseCtx = fixture([tool("ask_user")]);
  beforeUseCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(beforeUseCtx, JSON.stringify(beforeUseCheckpoint), model),
  ).toBeDefined();
  expect(beforeUseCtx.state.outsideText).not.toContain("never-seen@outside.test");

  const afterUseText = shortenToolResultText(
    raw,
    260,
    { name: "schedule_list" },
    { afterUse: true },
  );
  expect(afterUseText).not.toContain("never-seen@outside.test");
  expect(afterUseText).toContain(OMITTED_AFTER_USE);
  const afterUseCheckpoint = JSON.parse(checkpoint("ask_user"));
  afterUseCheckpoint.messages.unshift({
    role: "toolResult",
    toolCallId: "after-use-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: afterUseText }],
    details: shortDetails,
  });
  const afterUseCtx = fixture([tool("ask_user")]);
  afterUseCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(afterUseCtx, JSON.stringify(afterUseCheckpoint), model),
  ).toBeDefined();
  expect(afterUseCtx.state.outsideText).toContain("never-seen@outside.test");
});

it("decodes only visible lastCheck fragments on plain-text before-use cuts without flagging owner prompts", () => {
  const details = {
    routines: [
      {
        routineId: "r-plain-before",
        prompt: "Send weekly summary to owner-authored@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `line1\nvisible-head@outside.test ${"a".repeat(6_000)} omitted-mid@outside.test ${"b".repeat(5_500)} visible-tail@outside.test ${"c".repeat(2_000)}`,
        },
      },
    ],
  };
  const clipped = clipToolResultText(serializeToolResult(details, "current", "schedule_list", {}));
  expect(() => JSON.parse(clipped)).toThrow();
  expect(clipped).toContain("visible-head@outside.test");
  expect(clipped).toContain("omitted-mid@outside.test");

  const beforeUsePlain = shortenToolResultText(
    clipped,
    900,
    { name: "schedule_list" },
    { afterUse: false },
  );
  expect(beforeUsePlain).toContain("owner-authored@example.test");
  expect(beforeUsePlain).toContain("visible-head@outside.test");
  expect(beforeUsePlain).not.toContain("omitted-mid@outside.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift({
    role: "toolResult",
    toolCallId: "plain-before-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: beforeUsePlain }],
    details,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("visible-head@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-authored@example.test");
  expect(ctx.state.outsideText).not.toContain("omitted-mid@outside.test");
  expect(
    outsideOnlyTargets(
      {
        to: [
          "visible-head@outside.test",
          "owner-authored@example.test",
          "omitted-mid@outside.test",
        ],
      },
      { ownerWords: ["List schedules"], outsideText: ctx.state.outsideText },
    ),
  ).toEqual(["visible-head@outside.test"]);
});

it("keeps before-use omissions excluded when selectContext later compacts the result after use", () => {
  const details = {
    routines: [
      {
        routineId: "r-two-stage",
        prompt: "Send weekly summary to owner-prompt@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"x".repeat(4_800)} never-seen-stage1@outside.test ${"y".repeat(4_800)}`,
          entries: {
            "item-seen": `${"s".repeat(67)} seen-stage1@outside.test ${"t".repeat(67)}`,
          },
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  expect(raw.length).toBeLessThan(TOOL_RESULT_TEXT_LIMIT);

  // Stage 1 (before first use): selectContext shortens the newest tool result before the model sees it.
  const turn1 = selectContext(
    [
      { role: "user", content: "List schedules" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "two-stage-1", name: "schedule_list", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "two-stage-1",
        toolName: "schedule_list",
        content: [{ type: "text", text: raw }],
        details,
      },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      budget: { contextWindow: 2_600, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage1Msg = turn1.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage1Text = stage1Msg.content[0]?.text ?? "";
  expect(stage1Text).not.toContain("never-seen-stage1@outside.test");
  expect(stage1Text).toContain("seen-stage1@outside.test");
  expect(stage1Msg.details?.contextBeforeUseText).toBe(stage1Text);

  // Stage 2 (after use): a later assistant turn arrives and selectContext compacts the same result further.
  const turn2 = selectContext(
    [
      ...turn1.messages,
      { role: "assistant", content: [{ type: "text", text: "Checked schedules." }] },
      { role: "user", content: `Continue ${"c".repeat(40)}` },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      protectedIndexes: [1, 2],
      budget: {
        contextWindow: turn1.estimatedInputTokens + 10,
        outputReserve: 0,
        systemPrompt: "Fixture",
        tools: [],
      },
    },
  );
  const stage2Msg = turn2.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage2Text = stage2Msg.content[0]?.text ?? "";
  expect(stage2Text).not.toContain("never-seen-stage1@outside.test");
  expect(stage2Text).not.toContain("seen-stage1@outside.test");
  expect(stage2Text).toContain(OMITTED_AFTER_USE);
  expect(stage2Msg.details?.contextBeforeUseText).toBe(stage1Text);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(stage2Msg);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).not.toContain("never-seen-stage1@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-prompt@example.test");
  expect(ctx.state.outsideText).toContain("seen-stage1@outside.test");
});

it("keeps plain-text before-use cuts bounded across later after-use compaction", () => {
  const details = {
    routines: [
      {
        routineId: "r-plain-two-stage",
        prompt: "Forward digest to owner-plain-two-stage@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `hdr\nvisible-before-use@outside.test ${"a".repeat(6_000)} omitted-before-use@outside.test ${"b".repeat(6_000)} tail-end`,
        },
      },
    ],
  };
  const clipped = clipToolResultText(serializeToolResult(details, "current", "schedule_list", {}));
  expect(() => JSON.parse(clipped)).toThrow();
  expect(clipped).toContain("visible-before-use@outside.test");
  expect(clipped).toContain("omitted-before-use@outside.test");

  // Stage 1 (before first use): selectContext shortens the clipped plain-text result and records it.
  const turn1 = selectContext(
    [
      { role: "user", content: "List schedules" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "plain-two-stage", name: "schedule_list", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "plain-two-stage",
        toolName: "schedule_list",
        content: [{ type: "text", text: clipped }],
        details,
      },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      budget: { contextWindow: 3_600, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage1Msg = turn1.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage1Text = stage1Msg.content[0]?.text ?? "";
  expect(stage1Text).toContain("visible-before-use@outside.test");
  expect(stage1Text).not.toContain("omitted-before-use@outside.test");
  expect(stage1Msg.details?.contextBeforeUseText).toBe(stage1Text);

  // Stage 2 (after use): a later turn compacts the result further, dropping visible-before-use from text.
  const turn2 = selectContext(
    [
      ...turn1.messages,
      { role: "assistant", content: [{ type: "text", text: "Checked schedules." }] },
      { role: "user", content: "Continue" },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      protectedIndexes: [1, 2],
      budget: { contextWindow: 300, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage2Msg = turn2.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage2Text = stage2Msg.content[0]?.text ?? "";
  expect(stage2Text).not.toContain("visible-before-use@outside.test");
  expect(stage2Text).toContain(OMITTED_AFTER_USE);
  expect(stage2Msg.details?.contextBeforeUseText).toBe(stage1Text);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(stage2Msg);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("visible-before-use@outside.test");
  expect(ctx.state.outsideText).not.toContain("omitted-before-use@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-plain-two-stage@example.test");
});

it("preserves first-delivery watch snapshots across model policy switches", () => {
  const details = {
    routines: [
      {
        routineId: "r-model-switch",
        prompt: "Send weekly summary to owner-switch@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"x".repeat(12_000)} never-seen-switch@outside.test ${"y".repeat(12_000)}`,
          entries: {
            "item-seen": `${"s".repeat(165)} seen-before-switch@outside.test ${"t".repeat(165)}`,
            "item-extra": "e".repeat(900),
          },
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  const originalMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "switch-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "switch-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: raw }],
      details,
      isError: false,
      timestamp: 3,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "List schedules",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const policyA = createRuntimeContextPolicy(makeRequest("model-a", 7_200), undefined, {
    watchDeliveries,
  });
  const req1 = policyA.prepareContext(
    { systemPrompt: "Fixture", messages: originalMessages, tools: [] },
    makeModel("model-a", 7_200),
  );
  const req1Result = req1.messages.find((m) => m.role === "toolResult");
  const req1Text =
    req1Result && Array.isArray(req1Result.content) && req1Result.content[0]?.type === "text"
      ? req1Result.content[0].text
      : "";
  expect(req1Text.length).toBeGreaterThan(1_024);
  expect(req1Text).not.toContain("never-seen-switch@outside.test");
  expect(req1Text).toContain("seen-before-switch@outside.test");
  policyA.commitDelivery();

  // Switching models replaces the policy instance while keeping accepted watch provenance.
  // Staying in the same active user turn keeps switch-1 protected while making it after-use.
  const policyB = createRuntimeContextPolicy(makeRequest("model-b", 2_300), undefined, {
    watchDeliveries,
  });
  const req2 = policyB.prepareContext(
    {
      systemPrompt: "Fixture",
      messages: [
        ...originalMessages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "switch-2", name: "ask_user", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "model-a",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "switch-2",
          toolName: "ask_user",
          content: [{ type: "text", text: "y".repeat(7_500) }],
          isError: false,
          timestamp: 5,
        },
      ],
      tools: [],
    },
    makeModel("model-b", 2_300),
  );
  const req2Result = req2.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "switch-1",
  );
  const req2Text =
    req2Result && Array.isArray(req2Result.content) && req2Result.content[0]?.type === "text"
      ? req2Result.content[0].text
      : "";
  expect(req2Text).not.toContain("never-seen-switch@outside.test");
  expect(req2Text).not.toContain("seen-before-switch@outside.test");
  expect(req2Text).toContain(OMITTED_AFTER_USE);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(req2Result);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).not.toContain("never-seen-switch@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-switch@example.test");
  expect(ctx.state.outsideText).toContain("seen-before-switch@outside.test");
});

it("preserves literal backslashes in a watch item title after structured and plain-text before-use cuts", () => {
  const item = `item:${JSON.stringify({
    fields: [JSON.stringify(`field-head ${"f".repeat(9_000)}`)],
    title: `${"t".repeat(9_000)} a\\nb@o.test`,
  })}`;
  const paddingEntries = Object.fromEntries(
    Array.from({ length: 94 }, (_, i) => [`pad-${String(i).padStart(3, "0")}`, "p".repeat(110)]),
  );
  const details = {
    routines: [
      {
        routineId: "r-title-backslash",
        prompt: "Send update to owner-title@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          entries: {
            ...paddingEntries,
            "item-1": item,
            "z-tail": "q".repeat(120),
          },
        },
      },
    ],
  };
  const structuredClipped = clipToolResultText(
    serializeToolResult(details, "cache-aware", "schedule_list", {}),
  );
  expect(() => JSON.parse(structuredClipped)).toThrow();
  expect(structuredClipped).not.toContain(',\\"title\\":');
  const plainBeforeUse = shortenToolResultText(
    structuredClipped,
    380,
    { name: "schedule_list" },
    { afterUse: false },
  );
  expect(() => JSON.parse(plainBeforeUse)).toThrow();
  expect(plainBeforeUse).not.toContain("omitted evidence is unavailable");
  expect(plainBeforeUse).toContain("a\\\\\\\\nb@o.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift({
    role: "toolResult",
    toolCallId: "title-backslash-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: plainBeforeUse }],
    details,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("a\\nb@o.test");
  expect(ctx.state.outsideText).not.toContain("a\nb@o.test");
  expect(ctx.state.outsideText).not.toContain("owner-title@example.test");
});

it("keeps ordinary after-use tool compaction local to each model policy across switches", () => {
  const reportText = `${"r".repeat(3_474)}REPORT_TOTAL=42`;
  expect(reportText.length).toBe(3_489);
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const messages: Message[] = [
    { role: "user", content: "Read report", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read_file", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read_file",
      content: [{ type: "text", text: reportText }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "step-2", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "step-2",
      toolName: "ask_user",
      content: [{ type: "text", text: "y".repeat(6_000) }],
      isError: false,
      timestamp: 5,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "Read report",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const policyA = createRuntimeContextPolicy(makeRequest("model-a", 2_000), undefined, {
    watchDeliveries,
  });
  const reqA = policyA.prepareContext(
    { systemPrompt: "Fixture", messages, tools: [] },
    makeModel("model-a", 2_000),
  );
  const compactedRead = reqA.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "read-1",
  );
  const compactedText =
    compactedRead &&
    Array.isArray(compactedRead.content) &&
    compactedRead.content[0]?.type === "text"
      ? compactedRead.content[0].text
      : "";
  expect(compactedText.length).toBeLessThan(reportText.length);
  expect(compactedText).toContain(OMITTED_AFTER_USE);
  policyA.commitDelivery();

  const policyB = createRuntimeContextPolicy(makeRequest("model-b", 16_000), undefined, {
    watchDeliveries,
  });
  const reqB = policyB.prepareContext(
    { systemPrompt: "Fixture", messages, tools: [] },
    makeModel("model-b", 16_000),
  );
  const backupRead = reqB.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "read-1",
  );
  const backupText =
    backupRead && Array.isArray(backupRead.content) && backupRead.content[0]?.type === "text"
      ? backupRead.content[0].text
      : "";
  expect(backupText).toBe(reportText);
  expect(backupText).toContain("REPORT_TOTAL=42");
});

it("does not let a rejected primary request set first-delivery watch provenance for the backup", () => {
  const details = {
    routines: [
      {
        routineId: "r-rejected-primary",
        prompt: "Send update to owner-rejected@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(3_500)} backup-first-seen@outside.test ${"b".repeat(3_500)}`,
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const baseMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "rej-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "rej-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: raw }],
      details,
      isError: false,
      timestamp: 3,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "List schedules",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const primary = createRuntimeContextPolicy(makeRequest("model-a", 1_500), undefined, {
    watchDeliveries,
  });
  const rejectedReq = primary.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-a", 1_500),
  );
  const rejectedResult = rejectedReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const rejectedText =
    rejectedResult &&
    Array.isArray(rejectedResult.content) &&
    rejectedResult.content[0]?.type === "text"
      ? rejectedResult.content[0].text
      : "";
  expect(rejectedText.length).toBeLessThan(raw.length);
  expect(rejectedText).not.toContain("backup-first-seen@outside.test");
  // Primary failed before provider completion, so commitDelivery() is never called.

  const backup = createRuntimeContextPolicy(makeRequest("model-b", 16_000), undefined, {
    watchDeliveries,
  });
  const backupReq = backup.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-b", 16_000),
  );
  const backupResult = backupReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const backupText =
    backupResult && Array.isArray(backupResult.content) && backupResult.content[0]?.type === "text"
      ? backupResult.content[0].text
      : "";
  expect(backupText).toBe(raw);
  expect(backupText).toContain("backup-first-seen@outside.test");
  backup.commitDelivery();

  // Later after-use compaction on a narrower policy must remember backup's full accepted delivery.
  const narrow = createRuntimeContextPolicy(makeRequest("model-c", 2_000), undefined, {
    watchDeliveries,
  });
  const laterReq = narrow.prepareContext(
    {
      systemPrompt: "Fixture",
      messages: [
        ...baseMessages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "rej-2", name: "ask_user", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "model-b",
          usage: emptyUsage,
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "rej-2",
          toolName: "ask_user",
          content: [{ type: "text", text: "z".repeat(6_000) }],
          isError: false,
          timestamp: 5,
        },
      ],
      tools: [],
    },
    makeModel("model-c", 2_000),
  );
  const laterResult = laterReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const laterText =
    laterResult && Array.isArray(laterResult.content) && laterResult.content[0]?.type === "text"
      ? laterResult.content[0].text
      : "";
  expect(laterText).toContain(OMITTED_AFTER_USE);
  expect(laterText).not.toContain("backup-first-seen@outside.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(laterResult);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("backup-first-seen@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-rejected@example.test");
});

it("unions visible watch targets from a wider after-use delivery without restoring omitted spans", () => {
  const details = {
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(300)} seen-by-b@outside.test ${"m".repeat(8_000)} never-seen@outside.test ${"z".repeat(300)}`,
          entries: {
            "item-a": "seen-by-a@outside.test",
          },
        },
      },
    ],
  };
  const beforeUseText = JSON.stringify({
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(80)} [... omitted before use ...] ${"z".repeat(80)}`,
          entries: {
            "item-a": "seen-by-a@outside.test",
          },
        },
      },
    ],
  });
  const afterUseText = JSON.stringify({
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(300)} seen-by-b@outside.test ${OMITTED_AFTER_USE} ${"z".repeat(300)}`,
          entries: {
            "item-a": `seen ${OMITTED_AFTER_USE}`,
          },
        },
      },
    ],
  });

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift({
    role: "toolResult",
    toolCallId: "union-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: afterUseText }],
    details: { ...details, contextBeforeUseText: beforeUseText },
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("seen-by-a@outside.test");
  expect(ctx.state.outsideText).toContain("seen-by-b@outside.test");
  expect(ctx.state.outsideText).not.toContain("never-seen@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-union@example.test");
});
