import {
  GROK_BOT_EXPORT_MAX_LENGTH,
  GROK_BOT_EXPORT_PATH,
  THREAD_MESSAGE_TEXT_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { GrokBot, RoutineTriggersAvailable } from "./index.js";
import {
  agentImportLeftoverMessages,
  combineImportedInstructions,
  GROK_BOT_EXPORT_PROMPT,
  GrokBotExportError,
  grokBotExportJson,
  grokRoutineTrigger,
  grokSkillNames,
  NO_OPTIONAL_ROUTINE_TRIGGERS,
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

  it("joins a split export by explicit identity and counts a repeated part once", () => {
    const [monday, triage] = bramble.routines;
    const first = exportOf({
      export_id: "bramble",
      name: "Bramble",
      instructions: "Rule one.",
      memories: ["A"],
      routines: [monday],
    });
    const second = exportOf({
      export_id: "bramble",
      name: "bramble",
      instructions: "Rule two.",
      memories: ["B"],
      routines: [monday, triage],
    });
    const again = exportOf({ export_id: "bramble", name: "Bramble", instructions: "Rule two." });
    const bots = parseGrokBotExport(`Part 1:\n${first}\n\nPart 2:\n${second}\n\n${again}`);
    expect(bots).toHaveLength(1);
    expect(bots[0]!.name).toBe("Bramble");
    expect(bots[0]!.instructions).toBe("Rule one.\n\nRule two.");
    // Overlapping text is preserved: containment does not prove equal meaning.
    const fuller = exportOf({
      export_id: "bramble",
      name: "Bramble",
      instructions: "Rule one.\n\nRule two.",
    });
    const [whole] = parseGrokBotExport(
      `${exportOf({ export_id: "bramble", name: "Bramble", instructions: "Rule two." })}\n${fuller}`,
    );
    expect(whole!.instructions).toBe("Rule two.\n\nRule one.\n\nRule two.");
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

describe("a Grok Bot routine's trigger", () => {
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
  const none = NO_OPTIONAL_ROUTINE_TRIGGERS;
  const all: RoutineTriggersAvailable = { messageProviders: ["slack", "telegram"], email: true };
  const on = (trigger: string, available = all) =>
    grokRoutineTrigger({ ...routine, trigger }, available);

  it("keeps a valid cron on a clock trigger only", () => {
    expect(grokRoutineTrigger(routine, none)).toEqual({ kind: "schedule", cron: "0 8 * * 1-5" });
    expect(
      grokRoutineTrigger({ ...routine, cron: "", when: "every weekday at 8" }, all),
    ).toBeNull();
    expect(grokRoutineTrigger({ ...routine, cron: "", when: "30 9 * * *" }, none)).toEqual({
      kind: "schedule",
      cron: "30 9 * * *",
    });
  });

  it("maps events to the trigger that receives them here", () => {
    for (const trigger of ["webhook", "linear", "sentry", "pagerduty"]) {
      expect(on(trigger, none)).toEqual({ kind: "webhook" });
    }
    expect(on("github", none)).toEqual({ kind: "git" });
    expect(on("slack")).toEqual({ kind: "message", provider: "slack" });
    expect(on("email")).toEqual({ kind: "email" });
  });

  it("leaves events this server does not receive, and unknown ones, unmapped", () => {
    expect(on("slack", none)).toBeNull();
    expect(on("email", none)).toBeNull();
    expect(on("other")).toBeNull();
    expect(on("calendar")).toBeNull();
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
    expect(parsed.memory.map((item) => item.path)).toEqual(["MEMORY.md", "USER.md"]);
    expect(parsed.memory[0]!.content).toBe(
      "- Weekly report goes out on Mondays.\n- The team uses Linear.\n",
    );
    // A routine nothing here can start is left for the new bot's chat, never its memory.
    const leftovers = parsed.leftovers.map((item) => item.content).join("\n");
    expect(leftovers).toContain("Answer each new message in #support within the hour.");
    expect(leftovers).toContain("- Trigger: slack");
    expect(leftovers).not.toContain("Run the weekly account review.");
    expect(parsed.skills.map((item) => [item.name, item.description])).toEqual([
      ["weekly-account-health", "Use for the Monday account review."],
    ]);
    expect(grokSkillNames(bot!)).toEqual(
      new Map([
        ["weekly account health", "weekly-account-health"],
        ["weekly-account-health", "weekly-account-health"],
      ]),
    );
  });

  it("leaves an event this server receives out of the note", () => {
    const parsed = parseAgentImport(
      [{ path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot!) }],
      {},
      { messageProviders: ["slack"], email: false },
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.memory.map((item) => item.path)).toEqual(["MEMORY.md", "USER.md"]);
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
    ]);
    expect(parsed.leftovers.map((item) => item.content)).toEqual([
      expect.stringContaining(
        "- Schedule: every weekday at 9\n- Time zone: Europe/Lisbon\n- Skills: notes\n\nPost the standup.",
      ),
    ]);
  });

  it("leaves over a routine that fits one chat message, and lists a longer one as not imported", () => {
    const routine = (name: string, length: number) => ({
      name,
      instruction: "x".repeat(length),
      trigger: "other",
      cron: "",
      when: "",
      timeZone: "",
      skills: [],
      details: "",
    });
    const parsed = plan({ ...bot!, routines: [routine("Fits", 90_000), routine("Long", 100_000)] });
    expect(parsed.leftovers.map((item) => item.title)).toEqual(["Fits"]);
    expect(parsed.skipped).toContainEqual({ path: "routines: Long", reason: "unsupported" });
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

it("rejects oversized collections before allocating import names", () => {
  for (const field of ["skills", "apps", "routines"]) {
    const source = JSON.stringify({
      bots: [{ name: "Example", [field]: Array(101).fill({ name: "same" }) }],
    });
    expect(() => readGrokBotExportJson(source)).toThrow(GrokBotExportError);
  }
  expect(() =>
    readGrokBotExportJson(JSON.stringify({ bots: Array(101).fill({ name: "same" }) })),
  ).toThrow(GrokBotExportError);
});

it("bounds memories by the size of the document they become, not by count", () => {
  const memories = Array.from({ length: 300 }, (_, index) => `Fact ${index}.`);
  const userFacts = Array.from({ length: 150 }, (_, index) => `About me ${index}.`);
  const [bot] = readGrokBotExportJson(
    JSON.stringify({ bots: [{ name: "Example", memories, user_facts: userFacts }] }),
  );
  expect([bot!.memories.length, bot!.userFacts.length]).toEqual([300, 150]);
  const parsed = parseAgentImport([
    { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot!) },
  ]);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.memory.find((item) => item.path === "MEMORY.md")!.content).toContain("- Fact 299.");

  // Measured after repeats are dropped: thirty copies of one long memory fit.
  const repeated = Array.from({ length: 30 }, () => "x".repeat(4_000));
  const [once] = readGrokBotExportJson(
    JSON.stringify({ bots: [{ name: "Example", memories: repeated }] }),
  );
  const onceParsed = parseAgentImport([
    { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(once!) },
  ]);
  if ("error" in onceParsed) throw new Error(onceParsed.error);
  expect(onceParsed.memory).toHaveLength(1);

  // More than one document holds is split across several, every entry whole and in order.
  const longMemories = Array.from({ length: 60 }, (_, index) => `${index} ${"x".repeat(4_000)}`);
  const [split] = readGrokBotExportJson(
    JSON.stringify({
      bots: [{ name: "Example", memories: longMemories, user_facts: ["Name: Sam"] }],
    }),
  );
  const splitPlan = parseAgentImport([
    { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(split!) },
  ]);
  if ("error" in splitPlan) throw new Error(splitPlan.error);
  expect(splitPlan.memory.map((item) => item.path)).toEqual([
    "MEMORY.md",
    "MEMORY-2.md",
    "MEMORY-3.md",
    "USER.md",
  ]);
  const memoryText = splitPlan.memory
    .filter((item) => item.path.startsWith("MEMORY"))
    .map((item) => item.content);
  expect(memoryText.every((text) => text.length <= 100_000)).toBe(true);
  expect(memoryText.join("")).toBe(longMemories.map((entry) => `- ${entry}\n`).join(""));
  // Only an entry too long for a document of its own is refused.
  expect(() =>
    readGrokBotExportJson(
      JSON.stringify({ bots: [{ name: "Example", memories: ["z".repeat(100_000)] }] }),
    ),
  ).toThrow(GrokBotExportError);
  // A pasted reply full of repeats is re-sent with each entry once, within the upload limit.
  const longRepeats = Array.from({ length: 300 }, () => "y".repeat(4_000));
  const [pasted] = parseGrokBotExport(
    JSON.stringify({ bots: [{ name: "Example", memories: longRepeats }] }),
  );
  const resent = grokBotExportJson(pasted!);
  expect(pasted!.memories).toHaveLength(1);
  expect(resent.length).toBeLessThan(GROK_BOT_EXPORT_MAX_LENGTH);
  expect(readGrokBotExportJson(resent)[0]!.memories).toHaveLength(1);
  // Too many entries to fit are refused before any document is built.
  const many = Array.from({ length: 25_001 }, (_, index) => String(index));
  expect(() =>
    readGrokBotExportJson(JSON.stringify({ bots: [{ name: "Example", memories: many }] })),
  ).toThrow(GrokBotExportError);
});

it("joins a skill split across parts, and resolves exact skill names first", () => {
  const first = JSON.stringify({
    bots: [
      {
        export_id: "example",
        name: "Example",
        skills: [
          { name: "Review", description: "Weekly review", instructions: "1. Collect." },
          { name: "a b", description: "First", instructions: "One." },
          { name: "a-b", description: "Second", instructions: "Two." },
        ],
      },
    ],
  });
  const second = JSON.stringify({
    bots: [
      {
        export_id: "example",
        name: "Example",
        skills: [{ name: "Review", instructions: "2. Report." }],
      },
    ],
  });
  const [bot] = parseGrokBotExport(`${first}\n\n${second}`);
  expect(bot!.skills.map((skill) => [skill.name, skill.instructions])).toEqual([
    ["Review", "1. Collect.\n\n2. Report."],
    ["a b", "One."],
    ["a-b", "Two."],
  ]);
  const names = grokSkillNames(bot!);
  expect([names.get("a b"), names.get("a-b")]).toEqual(["a-b", "a-b-2"]);

  // Two same-named skills in one later part stay two skills.
  const pair = JSON.stringify({
    bots: [
      {
        export_id: "other",
        name: "Other",
        skills: [
          { name: "Check", instructions: "A." },
          { name: "Check", instructions: "B." },
        ],
      },
    ],
  });
  const [other] = parseGrokBotExport(
    `${JSON.stringify({ bots: [{ export_id: "other", name: "Other", memories: ["x"] }] })}\n\n${pair}`,
  );
  expect(other!.skills.map((skill) => skill.instructions)).toEqual(["A.", "B."]);
  // When an earlier part has one, it continues once and the other stays its own skill.
  const earlier = JSON.stringify({
    bots: [
      { export_id: "other", name: "Other", skills: [{ name: "Check", instructions: "Start." }] },
    ],
  });
  const [again] = parseGrokBotExport(`${earlier}\n\n${pair}`);
  expect(again!.skills.map((skill) => skill.instructions)).toEqual(["Start.\n\nA.", "B."]);
});

it("keeps skill names in any script", () => {
  const [bot] = parseGrokBotExport(
    JSON.stringify({
      bots: [
        {
          name: "Example",
          skills: [
            { name: "日报", description: "Daily report", instructions: "Write it." },
            { name: "Отчёт", description: "Weekly report", instructions: "Write it." },
          ],
        },
      ],
    }),
  );
  const parsed = parseAgentImport([
    { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot!) },
  ]);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.skills.map((skill) => skill.name)).toEqual(["日报", "отчет"]);
});

it("rejects explicit unrelated formats and newer string versions", () => {
  expect(() =>
    readGrokBotExportJson(JSON.stringify({ format: "other", bots: [{ name: "Example" }] })),
  ).toThrow(GrokBotExportError);
  expect(() =>
    readGrokBotExportJson(
      JSON.stringify({ format: "grok-bot-export", version: "2", bots: [{ name: "Example" }] }),
    ),
  ).toThrow(GrokBotExportError);
});

it("finds an indented export and ignores apostrophes in chat braces", () => {
  const indented = `{${" ".repeat(120)}"format": "grok-bot-export", "bots": [{"name": "Wren", "instructions": "Sam's rules."}]}`;
  expect(parseGrokBotExport(`Here it is:\n\`\`\`json\n${indented}\n\`\`\``)[0]?.name).toBe("Wren");
  const reply = `Notes on {Sam's bot}:\n\`\`\`json\n{"format": "grok-bot-export", "bots": [{"name": "Bramble", "instructions": "Use Sam's calendar."}]}\n\`\`\``;
  expect(parseGrokBotExport(reply)[0]?.instructions).toBe("Use Sam's calendar.");
});

it("reads braces inside JSON5 strings in fenced replies", () => {
  expect(
    parseGrokBotExport(
      "```json\n{format:'grok-bot-export', bots:[{name:'Example', instructions:'Keep } braces'}]}\n``` ",
    )[0]?.instructions,
  ).toBe("Keep } braces");
});

it("keeps populated aliases beside empty canonical arrays", () => {
  const [bot] = readGrokBotExportJson(
    JSON.stringify({
      bots: [
        {
          name: "Example",
          user_facts: [],
          userFacts: ["Prefers brief replies"],
          apps: [],
          integrations: ["Calendar"],
        },
      ],
    }),
  );
  expect(bot?.userFacts).toEqual(["Prefers brief replies"]);
  expect(bot?.apps.map((app) => app.name)).toEqual(["Calendar"]);
});

it("keeps contractions when repairing curly single quote delimiters", () => {
  expect(
    parseGrokBotExport(
      "{‘format’:‘grok-bot-export’,‘bots’:[{‘name’:‘Example’,‘instructions’:‘don’t forget’}]}",
    )[0]?.instructions,
  ).toBe("don’t forget");
});

it("keeps same-named bots and routines distinct", () => {
  const routines = ["First", "Second"].map((instruction) => ({
    name: "Daily",
    instruction,
    cron: "0 8 * * *",
  }));
  const bots = readGrokBotExportJson(
    JSON.stringify({
      bots: [
        { name: "Example", routines },
        { name: "Example", instructions: "Other" },
      ],
    }),
  );
  expect(bots).toHaveLength(2);
  expect(bots[0]?.routines.map((routine) => routine.instruction)).toEqual(["First", "Second"]);
});

it("preserves an opening instructions heading in exported rules", () => {
  expect(
    combineImportedInstructions([
      {
        title: "Instructions",
        content: "# Instructions for incidents\n\nFollow the runbook",
        role: "working",
      },
    ]),
  ).toBe("# Instructions for incidents\n\nFollow the runbook");
});

it("repairs each split document even when an earlier part already parses", () => {
  const first = JSON.stringify({
    bots: [{ export_id: "example", name: "Example", instructions: "First" }],
  });
  const second = JSON.stringify({
    bots: [{ export_id: "example", name: "Example", instructions: "Second" }],
  }).replace(/"/g, "“");
  expect(parseGrokBotExport(`${first}\n${second}`)[0]?.instructions).toBe("First\n\nSecond");
});

it("does not treat an app website as an MCP endpoint", () => {
  const [bot] = readGrokBotExportJson(
    JSON.stringify({
      bots: [{ name: "Example", apps: [{ name: "Calendar", url: "https://example.com" }] }],
    }),
  );
  expect(bot?.apps[0]?.mcpUrl).toBe("");
});

it("finds exports inside surrounding chat braces", () => {
  expect(
    parseGrokBotExport(
      'Here { export: {"bots":[{"name":"Example","instructions":"Keep this"}]} }',
    )[0]?.instructions,
  ).toBe("Keep this");
});

it("reads reordered export keys in fenced replies", () => {
  expect(
    parseGrokBotExport(
      '```json\n{"description":"Example","bots":[{"name":"Example","instructions":"Keep this"}]}\n```',
    )[0]?.instructions,
  ).toBe("Keep this");
});
it("preserves internal newline runs and leading indentation", () => {
  const content = `\n    code${"\n".repeat(100000)}end\n`;
  expect(combineImportedInstructions([{ title: "Instructions", content, role: "working" }])).toBe(
    content.slice(1, -1),
  );
});

it("ignores whitespace-only instructions without stripping code indentation", () => {
  expect(
    combineImportedInstructions([{ title: "Instructions", content: " \t \n", role: "working" }]),
  ).toBe("");
  expect(
    combineImportedInstructions([
      { title: "Instructions", content: "    code  ", role: "working" },
    ]),
  ).toBe("    code");
});

it("ignores braces and quotes inside JSON5 comments", () => {
  for (const comment of ['// { "\n', '/* } " { */']) {
    expect(
      parseGrokBotExport(
        `\`\`\`json\n{${comment}bots:[{name:"Example",instructions:"Keep"}]}\n\`\`\``,
      )[0]?.instructions,
    ).toBe("Keep");
  }
});
it("rejects an empty bot import plan", () => {
  expect(
    parseAgentImport([
      {
        path: GROK_BOT_EXPORT_PATH,
        content: JSON.stringify({ bots: [{ name: "Empty", skills: [] }] }),
      },
    ]),
  ).toHaveProperty("error");
});

it("does not offer nested bot-shaped metadata as another export", () => {
  const source = JSON.stringify({
    bots: [
      {
        name: "Actual",
        instructions: "Keep",
        metadata: { bots: [{ name: "Nested", instructions: "Ignore" }] },
      },
    ],
  });
  expect(parseGrokBotExport(`Here is the export:\n${source}`).map((bot) => bot.name)).toEqual([
    "Actual",
  ]);
});

it("does not count nested list entries as separate export documents", () => {
  const source = JSON.stringify({
    bots: [
      {
        name: "Example",
        skills: Array.from({ length: 60 }, (_, index) => ({
          name: `skill-${index}`,
          instructions: "Do it",
        })),
        routines: Array.from({ length: 60 }, (_, index) => ({
          name: `routine-${index}`,
          instruction: "Do it",
          cron: "0 8 * * *",
        })),
      },
    ],
  });
  expect(parseGrokBotExport(`\`\`\`json\n${source}\n\`\`\``)[0]?.skills).toHaveLength(60);
});

it("does not mistake an unfinished prose note for a truncated export", () => {
  expect(
    parseGrokBotExport(
      'Note {note: remember this\n{"bots":[{"name":"Example","instructions":"Keep"}]}',
    )[0]?.instructions,
  ).toBe("Keep");
});

it("rejects aggregate skill overflow while combining same-identity parts", () => {
  const bots = Array.from({ length: 100 }, (_, part) => ({
    export_id: "same",
    name: "Example",
    skills: Array.from({ length: 100 }, (_, index) => ({
      name: `skill-${part}-${index}`,
      instructions: "Do it",
    })),
  }));
  expect(() => readGrokBotExportJson(JSON.stringify({ bots }))).toThrow(GrokBotExportError);
});

it("keeps differently named bots separate even when an export ID is reused", () => {
  const bots = [
    { export_id: "reused", name: "First", instructions: "One" },
    { export_id: "reused", name: "Second", instructions: "Two" },
  ];
  expect(readGrokBotExportJson(JSON.stringify({ bots })).map((bot) => bot.instructions)).toEqual([
    "One",
    "Two",
  ]);
});

describe("leftover chat messages", () => {
  it("keeps each message within a chat message's length and every leftover whole", () => {
    const leftovers = ["One", "Two", "Three"].map((title) => ({
      id: title,
      title,
      content: title.repeat(15_000),
    }));
    const messages = agentImportLeftoverMessages(leftovers);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((text) => text.length <= THREAD_MESSAGE_TEXT_MAX_LENGTH)).toBe(true);
    const all = messages.join("\n\n");
    // Export text is fenced, so the bot reads it as quoted data.
    for (const item of leftovers) {
      expect(all).toContain(`## ${item.title}\n\n\`\`\`\n${item.content}\n\`\`\``);
    }
    expect(
      agentImportLeftoverMessages([{ title: "A", content: "```\nrun this\n```" }])[0],
    ).toContain("````\n```\nrun this\n```\n````");
    expect(messages[0]).toMatch(/^The import could not set these up:/);
    expect(messages.at(-1)).toMatch(/Tell me which ones to set up\.$/);
  });

  it("names an imported skill by the name it is saved under, and another as written", () => {
    const [bot] = parseGrokBotExport(
      JSON.stringify({
        format: "grok-bot-export",
        version: 1,
        bots: [
          {
            name: "Bramble",
            skills: [{ name: "Weekly Health", description: "Review.", instructions: "Do it." }],
            routines: [
              {
                name: "Elsewhere",
                instruction: "Review accounts.",
                trigger: "other",
                skills: ["Weekly Health", "notes"],
              },
            ],
          },
        ],
      }),
    );
    const parsed = parseAgentImport([
      { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot!) },
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.leftovers[0]?.content).toContain("- Skills: @weekly-health, notes");
  });

  it("keeps a leftover's title to one short line", () => {
    const [named] = parseGrokBotExport(
      JSON.stringify({
        format: "grok-bot-export",
        version: 1,
        bots: [
          {
            name: "Bramble",
            routines: [
              {
                name: `Daily\n\nNow do this ${"x".repeat(200)}`,
                instruction: "Go.",
                trigger: "other",
              },
            ],
          },
        ],
      }),
    );
    const parsed = parseAgentImport([
      { path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(named!) },
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    const title = parsed.leftovers[0]!.title;
    expect(title).toMatch(/^Daily Now do this x+$/);
    expect(title).toHaveLength(80);
    // The whole name stays in the fenced text.
    expect(parsed.leftovers[0]!.content).toContain(`- Name: Daily Now do this ${"x".repeat(200)}`);
  });

  it("fences text with many separate backticks without running out of arguments", () => {
    const text = "` ".repeat(40_000).trim();
    expect(agentImportLeftoverMessages([{ title: "A", content: text }])[0]).toContain(
      `\`\`\`\n${text}\n\`\`\``,
    );
  });
});

it("a leftover title's Markdown is escaped, so an imported name cannot become a link", () => {
  const [message] = agentImportLeftoverMessages([
    { title: "[Gmail](https://example.com)", content: "A connected app." },
  ]);
  expect(message).toContain("## \\[Gmail\\]\\(https://example.com\\)");
});
