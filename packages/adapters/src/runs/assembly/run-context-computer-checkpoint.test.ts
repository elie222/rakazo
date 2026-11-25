import type { ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { loadRunTurnState, retireIntroTurnCheckpoint } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import {
  MAX_OUTSIDE_TEXT_CHARS,
  outsideOnlyTargets,
} from "../../approvals/review-target-sources.js";
import { shortenToolResultText } from "../../runtime/context/context-selection.js";
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
