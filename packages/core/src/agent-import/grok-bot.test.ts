import { GROK_BOT_EXPORT_PATH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { GrokBot } from "./index.js";
import {
  GROK_BOT_EXPORT_PROMPT,
  GrokBotExportError,
  grokBotExportJson,
  grokRoutineCron,
  grokSkillNames,
  parseAgentImport,
  parseGrokBotExport,
  readGrokBotExportJson,
} from "./index.js";

const bramble = {
  name: "Bramble",
  title: "Account manager",
  instructions: "Keep replies short.\nCheck the CRM before answering.",
  memories: ["Weekly report goes out on Mondays.", "The team uses Linear."],
  user_facts: ["Name: Sam", "Time zone: America/New_York"],
  skills: [
    {
      name: "Weekly Account Health",
      description: "Use for the Monday account review.",
      instructions: "1. List accounts.\n2. Flag the ones at risk.",
    },
  ],
  routines: [
    {
      name: "Monday review",
      instruction: "Run the weekly account review.",
      trigger: "schedule",
      schedule_cron: "0 8 * * 1-5",
      schedule_text: "Weekdays at 8:00",
      timezone: "America/New_York",
      skills: ["Weekly Account Health"],
    },
    {
      name: "Triage support pings",
      instruction: "Answer each new message in #support within the hour.",
      trigger: "slack",
      trigger_details: "#support",
    },
  ],
  apps: [{ name: "Linear", mcp_url: "https://mcp.example.com/mcp" }],
};

function exportOf(...bots: object[]) {
  return JSON.stringify({ format: "grok-bot-export", version: 1, bots });
}

function errorCode(source: string) {
  try {
    parseGrokBotExport(source);
  } catch (error) {
    if (error instanceof GrokBotExportError) return error.code;
    throw error;
  }
  return null;
}

describe("reading a Grok Bot's reply", () => {
  it("finds the export in a chat reply despite curly quotes and trailing commas", () => {
    const fenced = JSON.stringify(bramble, null, 2).replace(/"/g, "“").replace(/\]\n/g, "],\n");
    const reply = `Here is my setup.\n\n\`\`\`json\n{“format”: “grok-bot-export”, “version”: 1, “bots”: [${fenced},]}\n\`\`\`\n\nI left nothing out.`;
    const [bot, ...rest] = parseGrokBotExport(reply);
    expect(rest).toEqual([]);
    expect(bot).toMatchObject({
      name: "Bramble",
      instructions: bramble.instructions,
      memories: bramble.memories,
      userFacts: bramble.user_facts,
    });
    expect(bot!.skills).toHaveLength(1);
    expect(bot!.routines).toHaveLength(2);
  });

  it("joins a split export by Bot name and counts a repeated part once", () => {
    const [monday, triage] = bramble.routines;
    const first = exportOf({
      name: "Bramble",
      instructions: "Rule one.",
      memories: ["A"],
      routines: [monday],
    });
    const second = exportOf({
      name: "bramble",
      instructions: "Rule two.",
      memories: ["B"],
      routines: [monday, triage],
    });
    const again = exportOf({ name: "Bramble", instructions: "Rule two." });
    const bots = parseGrokBotExport(`Part 1:\n${first}\n\nPart 2:\n${second}\n\n${again}`);
    expect(bots).toHaveLength(1);
    expect(bots[0]!.name).toBe("Bramble");
    expect(bots[0]!.instructions).toBe("Rule one.\n\nRule two.");
    // A later, fuller part replaces the earlier one it contains.
    const fuller = exportOf({ name: "Bramble", instructions: "Rule one.\n\nRule two." });
    const [whole] = parseGrokBotExport(
      `${exportOf({ name: "Bramble", instructions: "Rule two." })}\n${fuller}`,
    );
    expect(whole!.instructions).toBe("Rule one.\n\nRule two.");
    expect(bots[0]!.memories).toEqual(["A", "B"]);
    expect(bots[0]!.routines.map((routine) => routine.name)).toEqual([
      "Monday review",
      "Triage support pings",
    ]);
  });

  it("reads ordinary field names and keeps only the fields it uses", () => {
    const [bot] = parseGrokBotExport(
      JSON.stringify({
        bots: [
          {
            name: "A",
            memories: [{ key: "tz", text: "Time zone: PST" }],
            apps: [{ name: "Gmail", auth: "oauth", headers: { Authorization: "x" } }],
          },
        ],
      }),
    );
    expect(bot!.memories).toEqual(["Time zone: PST"]);
    expect(bot!.apps).toEqual([
      { name: "Gmail", mcpUrl: "", transport: "", headerNames: ["Authorization"] },
    ]);
  });

  it("says why a reply cannot be read", () => {
    expect(errorCode('{"format":"grok-bot-export","bots":[{"name":"A"')).toBe("cut_off");
    // A brace inside a curly-quoted value is text, not a part left open.
    expect(
      parseGrokBotExport(
        '{"format":"grok-bot-export","bots":[{"name":"A","instructions":“Use { to begin.”}]}',
      )[0]!.instructions,
    ).toBe("Use { to begin.");
    // A complete first part does not hide a later part that never closed.
    expect(
      errorCode(
        `${exportOf(bramble)}\n\nPart 2:\n{"format":"grok-bot-export","bots":[{"name":"Bramble"`,
      ),
    ).toBe("cut_off");
    expect(errorCode("Sure, I can help with that!")).toBe("not_export");
    expect(errorCode(exportOf(bramble).replace('"version":1', '"version":2'))).toBe(
      "newer_version",
    );
    expect(errorCode("x".repeat(4_000_001))).toBe("too_large");
  });

  it("reads back the document it writes for one Bot, strictly on the server", () => {
    const [bot] = parseGrokBotExport(exportOf(bramble));
    expect(parseGrokBotExport(grokBotExportJson(bot!))).toEqual([bot]);
    expect(readGrokBotExportJson(grokBotExportJson(bot!))).toEqual([bot]);
    // The server never searches or repairs: only the exact document is read.
    expect(() => readGrokBotExportJson(`Here it is: ${grokBotExportJson(bot!)}`)).toThrow(
      GrokBotExportError,
    );
  });

  it("asks for the fields it reads", () => {
    for (const field of ["user_facts", "schedule_cron", "trigger_details", "mcp_url"]) {
      expect(GROK_BOT_EXPORT_PROMPT).toContain(`"${field}"`);
    }
  });
});

describe("a Grok Bot routine's schedule", () => {
  const routine = {
    name: "",
    instruction: "x",
    trigger: "schedule",
    cron: "0 8 * * 1-5",
    when: "",
    timeZone: "",
    skills: [],
    details: "",
  };

  it("keeps a valid cron on a clock trigger only", () => {
    expect(grokRoutineCron(routine)).toBe("0 8 * * 1-5");
    expect(grokRoutineCron({ ...routine, trigger: "slack" })).toBeNull();
    expect(grokRoutineCron({ ...routine, cron: "", when: "every weekday at 8" })).toBeNull();
    expect(grokRoutineCron({ ...routine, cron: "", when: "30 9 * * *" })).toBe("30 9 * * *");
  });
});

describe("a Grok Bot as an import plan", () => {
  function plan(bot: GrokBot) {
    const parsed = parseAgentImport([
      { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot) },
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  }
  const [bot] = parseGrokBotExport(exportOf(bramble));

  it("maps instructions, memory, routines to set up again and skills", () => {
    const parsed = plan(bot!);
    expect(parsed.source).toBe("grok_bot");
    expect(parsed.suggestedName).toBe("Bramble");
    expect(parsed.suggestedDescription).toBe("Account manager");
    expect(parsed.instructions.map((item) => item.content)).toEqual([`${bramble.instructions}\n`]);
    expect(parsed.memory.map((item) => item.path)).toEqual([
      "MEMORY.md",
      "USER.md",
      "grok-bot-routines.md",
    ]);
    expect(parsed.memory[0]!.content).toBe(
      "- Weekly report goes out on Mondays.\n- The team uses Linear.\n",
    );
    const events = parsed.memory[2]!.content;
    expect(events).toContain("Answer each new message in #support within the hour.");
    expect(events).toContain("- Trigger: slack");
    expect(events).not.toContain("Run the weekly account review.");
    expect(parsed.skills.map((item) => [item.name, item.description])).toEqual([
      ["weekly-account-health", "Use for the Monday account review."],
    ]);
    expect(grokSkillNames(bot!)).toEqual(
      new Map([["weekly account health", "weekly-account-health"]]),
    );
  });

  it("keeps a fact in both memory files and files an unreadable schedule to set up again", () => {
    const [both] = parseGrokBotExport(
      exportOf({
        name: "Wren",
        memories: ["Name: Sam"],
        user_facts: ["Name: Sam"],
        routines: [
          {
            name: "Standup",
            instruction: "Post the standup.",
            schedule_text: "every weekday at 9",
            timezone: "Europe/Lisbon",
            skills: ["notes"],
          },
        ],
      }),
    );
    const parsed = plan(both!);
    expect(parsed.memory.map((item) => [item.path, item.content])).toEqual([
      ["MEMORY.md", "- Name: Sam\n"],
      ["USER.md", "- Name: Sam\n"],
      [
        "grok-bot-routines.md",
        expect.stringContaining(
          "- Schedule: every weekday at 9\n- Time zone: Europe/Lisbon\n- Skills: notes\n\nPost the standup.",
        ),
      ],
    ]);
  });

  it("keeps a skill's own metadata and an entry's own lines", () => {
    const parsed = plan({
      ...bot!,
      memories: ["Release steps:\n1. Tag\n2. Publish"],
      userFacts: [],
      skills: [
        {
          name: "Mac Notes",
          description: "",
          instructions:
            "---\nname: mac-notes\ndescription: Edit Apple Notes\nplatforms: [macos]\n---\n\nOpen Notes.",
        },
        {
          name: "Deploy",
          description: "",
          instructions:
            "---\nname: deploy\ndescription: Ship it\nmetadata:\n  openclaw:\n    requires:\n      env: [DEPLOY_TOKEN]\n---\n\nRun the deploy.",
        },
      ],
    });
    expect(parsed.memory[0]!.content).toBe("- Release steps:\n  1. Tag\n  2. Publish\n");
    const [mac, deploy] = parsed.skills;
    expect(mac!.name).toBe("mac-notes");
    expect(mac!.description).toBe("Edit Apple Notes");
    expect(mac!.status.kind).toBe("unsupported");
    // Nested metadata survives byte for byte, so its requirement still shows.
    expect(deploy!.content).toContain(
      "metadata:\n  openclaw:\n    requires:\n      env: [DEPLOY_TOKEN]",
    );
    expect(deploy!.status.kind).toBe("needs_setup");
  });

  it("flags key-shaped text and lists a skill with no text as skipped", () => {
    const parsed = plan({
      ...bot!,
      // Built from parts so no scanner mistakes this file for a leak.
      instructions: `Use ${["sk", "-proj-", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"].join("")} for the API.`,
      skills: [{ name: "Empty", description: "", instructions: "" }],
    });
    expect(parsed.instructions[0]!.containsKey).toBe(true);
    expect(parsed.skills).toEqual([]);
    expect(parsed.skipped).toEqual([{ path: "skills/Empty", reason: "invalid_skill" }]);
  });

  it("refuses a file holding several Bots", () => {
    const content = exportOf(bramble, { ...bramble, name: "Wren" });
    expect(parseAgentImport([{ path: GROK_BOT_EXPORT_PATH, content }])).toHaveProperty("error");
  });
});
