import { describe, expect, it } from "vitest";
import { BOT_FILES_EVAL_CASES } from "./bot-files.js";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";

function evidence(calls: Array<{ name: string; args: Record<string, unknown> }>): Evidence {
  return {
    text: "",
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: calls.map((call) => ({ step: 1, ...call })),
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}

const failed = (id: string, calls: Parameters<typeof evidence>[0]) =>
  BOT_FILES_EVAL_CASES.find((c) => c.id === id)!
    .grade(evidence(calls))
    .filter((criterion) => !criterion.pass)
    .map((criterion) => criterion.id);

describe("bot files eval", () => {
  it("passes a folder sent by path and fails one pasted into the message", () => {
    expect(
      failed("send-folder-on-shared-computer", [
        { name: "message_bot", args: { bot_id: "servo", message: "Deploy", files: ["site"] } },
      ]),
    ).toEqual([]);
    expect(
      failed("send-folder-on-shared-computer", [
        {
          name: "message_bot",
          args: {
            bot_id: "servo",
            message:
              "export function renderLaunchCards(cards) {\n  return cards.filter((card) => card.ready).map(renderCard);\n}",
          },
        },
      ]),
    ).toHaveLength(2);
  });

  it("needs the zip to reach a teammate with its own computer, even after a refused folder", () => {
    expect(
      failed("send-zip-to-own-computer", [
        { name: "message_bot", args: { message: "Deploy", files: ["site"] } },
        { name: "message_bot", args: { message: "Deploy", files: ["site.zip"] } },
      ]),
    ).toEqual([]);
    expect(
      failed("send-zip-to-own-computer", [
        { name: "message_bot", args: { message: "Deploy", files: ["site"] } },
      ]),
    ).toEqual(['calls message_bot({"files":"~site.zip"})']);
  });

  it("grades a group pass-off on the handoff, and a question on sending nothing", () => {
    expect(
      failed("hand-off-folder-in-group", [
        { name: "handoff_to_bot", args: { message: "Deploy", files: ["site"] } },
      ]),
    ).toEqual([]);
    expect(
      failed("question-sends-no-files", [
        { name: "message_bot", args: { message: "Is it up?", files: ["site"] } },
      ]),
    ).toEqual(['does not call message_bot({"files":"~site"})']);
  });

  it("delivers the receiving case as a teammate's message naming the peer's folder", () => {
    const receiver = BOT_FILES_EVAL_CASES.find((c) => c.id === "receive-shared-path")!;
    expect(receiver.steps).toEqual([{ fromPeer: expect.stringContaining("{peerHome}/site") }]);
    expect(receiver.computerFiles?.every((file) => file.owner === "peer")).toBe(true);
    expect(
      failed("receive-shared-path", [{ name: "list_files", args: { path: "bots/coder/site" } }]),
    ).toEqual([]);
  });
});
