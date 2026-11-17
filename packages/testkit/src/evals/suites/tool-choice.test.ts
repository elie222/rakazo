import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import { EMPTY_SETTINGS } from "../cases.js";
import {
  gradeToolChoice,
  loadToolChoiceCases,
  TOOL_CHOICE_JUDGE_CALIBRATION,
  TOOL_CHOICE_JUDGE_VERSION,
  ToolChoiceCaseSchema,
  toolChoiceEvalCase,
} from "./tool-choice.js";
import { TOOL_CHOICE_CASES, TOOL_CHOICE_DEFINITIONS } from "./tool-choice-cases.js";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
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
    toolCalls: [],
    finalStep: 2,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
    ...overrides,
  };
}

const passes = (criteria: Array<{ pass: boolean }>) => criteria.every((c) => c.pass);

describe("tool-choice grading", () => {
  it("grades only the final step's calls", () => {
    const toolCalls = [
      { step: 1, name: "update_bot", args: { name: "Scout" } },
      { step: 2, name: "web_search", args: { query: "node" } },
    ];
    expect(passes(gradeToolChoice({ notCalls: ["update_bot"] }, evidence({ toolCalls })))).toBe(
      true,
    );
    expect(
      passes(gradeToolChoice({ calls: [{ tool: "update_bot" }] }, evidence({ toolCalls }))),
    ).toBe(false);
  });

  it("matches substrings, presence, alternatives and exact values", () => {
    const toolCalls = [{ step: 2, name: "update_bot", args: { name: "Scout Bot", color: "#0a0" } }];
    const ok = (args: Record<string, unknown>) =>
      passes(
        gradeToolChoice(
          { calls: [{ tool: "update_bot", args: args as never }] },
          evidence({ toolCalls }),
        ),
      );
    expect(ok({ name: "~scout" })).toBe(true);
    expect(ok({ color: "*" })).toBe(true);
    expect(ok({ name: ["Atlas", "Scout Bot"] })).toBe(true);
    expect(ok({ name: "Scout" })).toBe(false);
    expect(ok({ description: "*" })).toBe(false);
  });

  it("forbids every tool with *", () => {
    const toolCalls = [{ step: 2, name: "remember", args: {} }];
    expect(passes(gradeToolChoice({ notCalls: ["*"] }, evidence({ toolCalls })))).toBe(false);
    expect(passes(gradeToolChoice({ notCalls: ["*"] }, evidence()))).toBe(true);
  });

  it("checks order and call limits", () => {
    const toolCalls = ["find", "use", "find"].map((name) => ({ step: 2, name, args: {} }));
    expect(passes(gradeToolChoice({ order: ["find", "use"] }, evidence({ toolCalls })))).toBe(true);
    expect(passes(gradeToolChoice({ order: ["use", "other"] }, evidence({ toolCalls })))).toBe(
      false,
    );
    expect(passes(gradeToolChoice({ maxCalls: { find: 1 } }, evidence({ toolCalls })))).toBe(false);
  });

  it("grades use_tool calls as the tool they ran, and only on tools find_tool loaded", () => {
    const found = { step: 2, name: "find_tool", args: { query: "chart" } };
    const plot = { step: 2, name: "render_plot", args: {}, viaUseTool: true };
    const expect_ = { order: ["find_tool", "render_plot"] };
    const grade = (toolCalls: Evidence["toolCalls"]) =>
      passes(gradeToolChoice(expect_, evidence({ toolCalls })));
    expect(grade([found, { ...plot, loaded: true }])).toBe(true);
    expect(grade([found, { ...plot, loaded: false }])).toBe(false);
    expect(grade([found, { ...plot, loaded: true }, { step: 2, name: "use_tool", args: {} }])).toBe(
      false,
    );
    expect(passes(gradeToolChoice({ notCalls: ["find_tool"] }, evidence()))).toBe(true);
  });

  it("grades settings by state, and treats a field-less update_bot as a read", () => {
    const before = { bot: { name: "Assistant", modelId: "a" }, user: { timezone: null } };
    const after = { bot: { name: "Assistant", modelId: "b" }, user: { timezone: null } };
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: after }),
        ),
      ),
    ).toBe(false);
    expect(passes(gradeToolChoice({ bot: { modelId: "b" } }, evidence({ settings: after })))).toBe(
      true,
    );
    const read = [{ step: 2, name: "update_bot", args: { model: null, name: " " } }];
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: before, toolCalls: read }),
        ),
      ),
    ).toBe(true);
    const write = [{ step: 2, name: "update_bot", args: { name: "Assistant" } }];
    expect(
      passes(
        gradeToolChoice(
          { settingsUnchanged: true },
          evidence({ settingsBefore: before, settings: before, toolCalls: write }),
        ),
      ),
    ).toBe(false);
  });

  it("has unique ids, both kinds in every behavior area, and rejects empty evidence for guards", () => {
    expect(new Set(TOOL_CHOICE_DEFINITIONS.map((c) => c.id)).size).toBe(
      TOOL_CHOICE_DEFINITIONS.length,
    );
    expect(TOOL_CHOICE_DEFINITIONS.length).toBeGreaterThanOrEqual(60);
    for (const area of ["settings", "user-settings", "product-help"])
      expect(
        new Set(TOOL_CHOICE_DEFINITIONS.filter((c) => c.area === area).map((c) => c.kind)),
      ).toEqual(new Set(["guard", "control"]));
    for (const scenario of TOOL_CHOICE_CASES) {
      const definition = TOOL_CHOICE_DEFINITIONS.find((c) => c.id === scenario.id)!;
      const empty = evidence({
        finalStep: scenario.steps.length,
        settings: { bot: { name: "Assistant" }, user: {} },
        settingsBefore: { bot: { name: "Assistant" }, user: {} },
      });
      if (definition.kind === "guard")
        expect(passes(scenario.grade(empty)), scenario.id).toBe(false);
    }
  });

  it("loads local cases as JSON lines and validates them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-choice-"));
    const file = path.join(dir, "cases.ndjson");
    writeFileSync(
      file,
      `${JSON.stringify({ id: "local-a", area: "settings", kind: "control", purpose: "x", prompt: "hi", expect: { notCalls: ["*"] } })}\n`,
    );
    const [loaded] = loadToolChoiceCases(file);
    expect(loaded!.id).toBe("local-a");
    expect(loaded!.steps).toEqual([{ ask: "hi" }]);
    writeFileSync(
      file,
      JSON.stringify([
        { id: "Bad Id", area: "x", kind: "guard", purpose: "x", prompt: "x", expect: {} },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow();
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "only-bans",
          area: "x",
          kind: "guard",
          purpose: "x",
          prompt: "x",
          expect: { notCalls: ["*"] },
        },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow(/guard needs/);
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "empty-bot",
          area: "x",
          kind: "guard",
          purpose: "x",
          prompt: "x",
          expect: { bot: {} },
        },
      ]),
    );
    expect(() => loadToolChoiceCases(file)).toThrow(/guard needs/);
  });

  it("sends prose settings to the judge instead of matching their wording", () => {
    const scenario = TOOL_CHOICE_CASES.find((c) => c.id === "settings-instructions-add")!;
    const input = scenario.judge!(
      evidence({ settings: { ...EMPTY_SETTINGS, bot: { instructions: "Use short lists." } } }),
    );
    expect(input.rubric.startsWith(`${TOOL_CHOICE_JUDGE_VERSION}:`)).toBe(true);
    expect(input.evidence).toMatchObject({
      request: "Update your instructions so you always answer in bullet points.",
      settings: { instructions: { saved: "Use short lists." } },
    });
    const base = { id: "x", area: "settings", kind: "guard", prompt: "p", purpose: "p" } as const;
    expect(
      ToolChoiceCaseSchema.safeParse({ ...base, expect: { bot: { instructions: "~bullet" } } })
        .success,
    ).toBe(false);
    expect(
      ToolChoiceCaseSchema.safeParse({
        ...base,
        expect: { calls: [{ tool: "update_bot", args: { description: "~metrics" } }] },
      }).success,
    ).toBe(false);
  });

  it("grades a prose wildcard by meaning, and lets exact values through", () => {
    const base = { id: "x", area: "settings", kind: "guard", prompt: "p", purpose: "p" } as const;
    const parses = (expect: object) => ToolChoiceCaseSchema.safeParse({ ...base, expect }).success;
    expect(parses({ bot: { instructions: "*" } })).toBe(false);
    expect(parses({ calls: [{ tool: "update_bot", args: { description: "*" } }] })).toBe(false);
    // A null or blank bot_id still updates the calling bot, as the tool reads it.
    for (const bot_id of [null, "", " "])
      expect(parses({ calls: [{ tool: "update_bot", args: { bot_id, instructions: "*" } }] })).toBe(
        false,
      );
    expect(parses({ bot: { instructions: ["*", null] } })).toBe(false);
    const keepsName = { calls: [{ tool: "update_bot", args: { name: "Scout" } }] };
    expect(
      parses({ ...keepsName, callsMustNot: [{ tool: "update_bot", args: { instructions: "*" } }] }),
    ).toBe(true);
    const meaningOnly = toolChoiceEvalCase({
      ...base,
      expect: { botMeans: { instructions: "Review pull requests." } },
    });
    expect(meaningOnly.judge).toBeDefined();
    expect(parses({ bot: { instructions: null } })).toBe(true);
    expect(parses({ bot: { description: "" } })).toBe(true);
    expect(parses({ bot: { instructions: "Help with travel planning." } })).toBe(true);
    expect(parses({ bot: { instructions: ["~travel", null] } })).toBe(false);
    expect(
      parses({
        ...keepsName,
        callsMustNot: [{ tool: "update_bot", args: { instructions: [null, ""] } }],
      }),
    ).toBe(true);
  });

  it("judges only the bot's own settings; other tools' prose arguments need only be present", () => {
    const base = { id: "x", area: "settings", kind: "guard", prompt: "p", purpose: "p" } as const;
    for (const others of [
      { calls: [{ tool: "spawn_bot", args: { instructions: "*" } }] },
      { anyOf: [{ tool: "skill_create", args: { description: "*" } }] },
      { calls: [{ tool: "update_bot", args: { bot_id: "*", instructions: "*" } }] },
    ]) {
      const scenario = toolChoiceEvalCase({ ...base, expect: others });
      expect(scenario.judge).toBeUndefined();
    }
    expect(
      ToolChoiceCaseSchema.safeParse({
        ...base,
        expect: { calls: [{ tool: "spawn_bot", args: { instructions: "~bullet" } }] },
      }).success,
    ).toBe(false);
  });

  it("sends the final reply to the judge with what it must convey", () => {
    const base = {
      id: "x",
      area: "help",
      kind: "guard",
      prompt: "Who reads your memory?",
    } as const;
    const scenario = toolChoiceEvalCase({
      ...base,
      purpose: "p",
      expect: { replyMeans: "Says its own memory is private." },
    });
    const input = scenario.judge!(evidence({ text: "Only I read my notes." }));
    expect(input.evidence).toEqual({
      request: "Who reads your memory?",
      reply: { text: "Only I read my notes.", expected: "Says its own memory is private." },
    });
  });

  it("calibrates the judge against passing and failing references", () => {
    expect(new Set(TOOL_CHOICE_JUDGE_CALIBRATION.map((c) => c.pass))).toEqual(
      new Set([true, false]),
    );
    for (const { input } of TOOL_CHOICE_JUDGE_CALIBRATION)
      expect(input.rubric.startsWith(`${TOOL_CHOICE_JUDGE_VERSION}:`)).toBe(true);
  });
});
