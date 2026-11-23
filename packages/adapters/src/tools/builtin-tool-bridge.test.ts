import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  selectBuiltinToolsForRun,
} from "../runs/tools/run-tool-selection.js";
import { describeToolActivity } from "../runtime/pi/tools/pi-runtime-tools.js";
import { FIND_TOOL, USE_TOOL } from "./builtin.tool-definition.js";
import { CORE_BUILTIN_TOOL_NAMES, findTools, partitionTools } from "./builtin-tool-bridge.js";

const ownerChat = selectBuiltinToolsForRun({
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
  fleetManagement: true,
  followUpFromUser: true,
});

const definitionBytes = (tools: typeof ownerChat) =>
  Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

describe("built-in tool bridge", () => {
  it("lists a pinned tool set within a byte budget on an owner chat run", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
      "attach_file",
      "connect_app",
      "find_tool",
      "list_files",
      "message_bot",
      "message_user",
      "read_file",
      "read_history",
      "remember",
      "request_secret",
      "request_takeover",
      "run_subagent",
      "schedule_create",
      "schedule_list",
      "search_history",
      "shell",
      "skill_read",
      "update_bot",
      "update_preferences",
      "use_tool",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    // request_secret carries the card and contact kinds; update_bot carries instructions paging;
    // the history tools point at files from earlier messages; a watch says it takes no other timing;
    // read_file takes a line range; ask_user carries the content being decided about;
    // search_history lists earlier tool work by kind without a keyword; message_bot is the
    // most used deferred tool, and a lookup before each message cost a step; schedule_create says
    // whether a routine runs in its chat, and takes the events (webhook, Git, chat, email) a
    // routine can start on, saying a Git event needs no connected app; schedule_list reaches a
    // managed bot's routines; update_bot carries the settings its owner can change;
    // update_preferences includes the chat model picker and reply streaming.
    expect(definitionBytes(listed)).toBeLessThanOrEqual(36_400);
    expect(deferred.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["render_plot", "create_space", "generate_secret", "scratchpad_add"]),
    );
  });

  it("names only real built-ins as core", () => {
    for (const name of CORE_BUILTIN_TOOL_NAMES) expect(BUILTIN_AGENT_TOOL_NAMES).toContain(name);
  });

  it("lists every tool when none is deferred", () => {
    const core = ownerChat.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
    expect(partitionTools(core)).toEqual({ listed: core, deferred: [] });
  });

  it("names deferred tools by area in find_tool, without schemas", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const tool of deferred) expect(description).toContain(tool.name);
    expect(description).toContain("secrets:\n");
    expect(description).not.toContain("inputSchema");
    expect(listed.some((tool) => tool.name === USE_TOOL)).toBe(true);
  });

  it("finds exact names and ranks a query over names, descriptions and parameters", () => {
    const { deferred } = partitionTools(ownerChat);
    const plot = findTools(deferred, { names: ["render_plot", "shell", "nope"] });
    expect(plot.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(plot.tools[0]!.inputSchema).toEqual(
      deferred.find((tool) => tool.name === "render_plot")!.inputSchema,
    );
    expect(plot.unknown).toEqual(["shell", "nope"]);

    const names = (query: string) => findTools(deferred, { query }).tools.map((tool) => tool.name);
    expect(names("chart")).toContain("render_plot");
    expect(names("new space")[0]).toBe("create_space");
    expect(names("generate password")[0]).toBe("generate_secret");
    expect(names("scratchpad add")[0]).toBe("scratchpad_add");
    expect(names("scratchpad").length).toBe(3);
    expect(findTools(deferred, { query: "zzzz" })).toMatchObject({
      tools: [],
      hint: expect.any(String),
    });
  });

  it("never finds a tool the bot turned off", () => {
    const { listed, deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        disabledBuiltinTools: ["render_plot"],
      }),
    );
    expect(findTools(deferred, { names: ["render_plot"] })).toMatchObject({
      tools: [],
      unknown: ["render_plot"],
    });
    expect(listed.find((tool) => tool.name === FIND_TOOL)!.description).not.toContain(
      "render_plot",
    );
  });

  it("shows the real tool as activity", () => {
    expect(
      describeToolActivity(USE_TOOL, { name: "create_space", arguments: { name: "Finance" } }),
    ).toBe("Creating space: Finance");
  });
});

describe("bridge tool definitions", () => {
  it("renders find_tool with the deferred names by area, and use_tool", () => {
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
    const { listed } = partitionTools([tool("shell"), tool("list_secrets"), tool("render_plot")]);
    expect(listed.slice(1)).toEqual([
      {
        name: "find_tool",
        description:
          "Find deferred tool parameters by name or query before calling use_tool.\nmedia:\n  render_plot\nsecrets:\n  list_secrets",
        inputSchema: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string" }, maxItems: 5 },
            query: { type: "string", maxLength: 200, description: "Words describing the task" },
          },
        },
        readOnly: true,
      },
      {
        name: "use_tool",
        description: "Run a tool returned by find_tool this turn.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object", description: "Arguments matching its parameters" },
          },
          required: ["name", "arguments"],
        },
      },
    ]);
  });
});
