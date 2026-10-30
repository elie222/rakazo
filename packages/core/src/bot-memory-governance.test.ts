import { describe, expect, it } from "vitest";
import {
  type BotMemoryEvidence,
  type BotMemoryReader,
  canRecallBotMemory,
  forgottenMemoryStatus,
} from "./bot-memory-governance.js";

const reader: BotMemoryReader = {
  ownerUserId: "owner",
  spaceId: "space",
  botId: "bot",
  currentGeneration: 2,
  sharedScopeIds: ["team"],
};
const privateMemory: BotMemoryEvidence = {
  ownerUserId: "owner",
  spaceId: "space",
  botId: "bot",
  scope: "private",
  suppressed: false,
};

describe("memory recall authorization", () => {
  it("permits current private evidence and durable notes without a generation", () => {
    expect(canRecallBotMemory(reader, privateMemory)).toBe(true);
    expect(canRecallBotMemory(reader, { ...privateMemory, sourceGeneration: 2 })).toBe(true);
  });

  it.each([
    { suppressed: true },
    { ownerUserId: "other" },
    { botId: "other" },
    { spaceId: "other" },
    { sourceGeneration: 1 },
  ])("rejects private memory outside current scope %j", (patch) => {
    expect(canRecallBotMemory(reader, { ...privateMemory, ...patch })).toBe(false);
  });

  it("requires an explicit currently authorized shared namespace", () => {
    const shared: BotMemoryEvidence = {
      ...privateMemory,
      scope: "shared",
      ownerUserId: "peer",
      botId: "peer-bot",
      sharedScopeId: "team",
    };
    expect(canRecallBotMemory(reader, shared)).toBe(true);
    expect(canRecallBotMemory({ ...reader, sharedScopeIds: [] }, shared)).toBe(false);
    expect(canRecallBotMemory(reader, { ...shared, sourceGeneration: 2 })).toBe(false);
    expect(canRecallBotMemory(reader, { ...shared, suppressed: true })).toBe(false);
  });

  it.each(["pending", "failed", "completed"] as const)(
    "suppresses retrieval while deletion is %s without false erasure claims",
    (remoteDeletion) => {
      expect(forgottenMemoryStatus(remoteDeletion)).toEqual({
        suppressed: true,
        remoteDeletion,
        erasureConfirmed: remoteDeletion === "completed",
      });
    },
  );
});
