import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { restoreTurnCheckpoint, serializeTurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import { historyImageSeenNote } from "../context/history-replay.prompt.js";
import { buildTurnCheckpoint, upgradeCheckpointHistory } from "./pi-runtime-checkpoint.js";
import { HISTORY_FORMAT_VERSION } from "./pi-runtime-history.js";

const image = { type: "image" as const, data: "Zml4dHVyZQ==", mimeType: "image/png" };
const history = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "Earlier" }, image],
  timestamp: Date.parse("2026-11-19T02:31:00Z"),
  rakazoHistory: true,
};
const current = { role: "user" as const, content: [image], timestamp: 1 };
const base = {
  version: 1 as const,
  provider: "fixture",
  model: "model",
  systemPrompt: "fixture",
  pendingToolCallId: "pending",
};

describe("checkpoint history upgrade", () => {
  it("marks only tagged history images and preserves current turn images", () => {
    const messages = [history, current, { ...current, timestamp: 2 }] as Message[];
    const restored = restoreTurnCheckpoint(serializeTurnCheckpoint({ ...base, messages }), {
      provider: "fixture",
      id: "model",
    });
    const upgraded = upgradeCheckpointHistory(restored);
    expect(upgraded.messages[0]).toMatchObject({
      content: [
        {
          type: "text",
          text: "[2026-11-19 02:31, image from an earlier message]\nEarlier",
        },
        image,
      ],
    });
    expect(upgraded.messages.slice(1)).toEqual(messages.slice(1));
  });

  it("does not duplicate existing notes and handles missing timestamps", () => {
    const stamp = "2026-11-19 02:31";
    const marked = {
      ...history,
      content: [{ type: "text" as const, text: `${historyImageSeenNote(stamp)}\nEarlier` }, image],
    };
    const undated = { ...history, timestamp: 0, content: [image] };
    const upgraded = upgradeCheckpointHistory({
      ...base,
      historyFormat: 3,
      messages: [marked, undated],
    });
    expect(upgraded.messages[0]).toEqual(marked);
    expect(upgraded.messages[1]).toMatchObject({
      content: [{ type: "text", text: "[image from an earlier message]" }, image],
    });
    expect(upgradeCheckpointHistory(upgraded).messages).toEqual(upgraded.messages);
  });

  it("leaves current-format checkpoints untouched", () => {
    const checkpoint = { ...base, historyFormat: HISTORY_FORMAT_VERSION, messages: [history] };
    expect(upgradeCheckpointHistory(checkpoint)).toBe(checkpoint);
  });

  it("records the history format in newly built checkpoints", () => {
    const checkpoint = buildTurnCheckpoint({
      stateMessages: [current],
      restoringCalls: false,
      tools: [],
      pendingToolCallId: "pending",
      toolCallCount: 0,
      mainModelConfig: { provider: "fixture", id: "model" },
      provider: "fixture",
      modelId: "model",
      systemPrompt: "fixture",
      representedHistoryIds: new Set(),
    });
    expect(checkpoint.historyFormat).toBe(HISTORY_FORMAT_VERSION);
  });
});
