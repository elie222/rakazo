import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { SUBAGENT_EVAL_CASES } from "./subagents.js";

function evidence(): Evidence {
  return {
    text: "I'll delegate that.",
    delegation: {
      helpers: [{ status: "completed", tools: ["read_file", "write_file"] }],
      results: [{ status: "completed", text: "The shipment has 19 units and costs 151." }],
    },
    files: { "results/shipment.json": '{"units":19,"cost":151}' },
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: [],
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}

describe("subagent eval outcomes", () => {
  const scenario = SUBAGENT_EVAL_CASES[0]!;
  const passes = (e: Evidence) => scenario.grade(e).every((criterion) => criterion.pass);

  it("requires actual helper actions and a completed parent result, beyond a correct file", () => {
    const e = evidence();
    expect(passes(e)).toBe(true);
    e.delegation!.helpers[0]!.tools = [];
    expect(passes(e)).toBe(false);
    e.delegation!.helpers[0]!.tools = ["read_file", "write_file"];
    e.delegation!.results = [];
    expect(passes(e)).toBe(false);
  });

  it("rejects missing, malformed and incorrect saved results despite a success claim", () => {
    const e = evidence();
    for (const content of [null, "Done", '{"units":20,"cost":151}', '{"units":"19","cost":151}']) {
      e.files["results/shipment.json"] = content;
      expect(passes(e)).toBe(false);
    }
  });

  it("grades the delivered connected reply and rejects delivery to another conversation", () => {
    const connected = SUBAGENT_EVAL_CASES.find((item) => item.id === "subagent-connected-action")!;
    const e = evidence();
    e.messaging = {
      originThreadId: "origin",
      outbound: [{ threadId: "other", handle: "reply", body: "Delivered reply" }],
    };
    expect(connected.grade(e).every((criterion) => criterion.pass)).toBe(false);
    e.messaging.outbound[0]!.threadId = "origin";
    expect(connected.grade(e).every((criterion) => criterion.pass)).toBe(true);
    expect(connected.judge!(e).evidence).toEqual({ task: "shipment", reply: "Delivered reply" });
  });

  it("rejects a helper's duplicate write and collateral changes to another record", () => {
    const connector = SUBAGENT_EVAL_CASES.find((item) => item.id === "subagent-connector-action")!;
    const e = evidence();
    e.delegation!.helpers[0]!.tools = ["CRM_UPDATE_RECORD"];
    e.records = [
      { id: "customer-1", name: "Example Bakery", status: "active", priority: "normal" },
      { id: "customer-2", name: "Example Books", status: "lead", priority: "normal" },
    ];
    e.calls = [
      {
        tool: "CRM_UPDATE_RECORD",
        args: { recordId: "customer-1", status: "active" },
        outcome: "write",
      },
    ];
    expect(connector.grade(e).every((criterion) => criterion.pass)).toBe(true);
    e.calls.push({ ...e.calls[0]! });
    expect(connector.grade(e).every((criterion) => criterion.pass)).toBe(false);
    e.calls.pop();
    e.records[1]!.status = "active";
    expect(connector.grade(e).every((criterion) => criterion.pass)).toBe(false);
  });
});
