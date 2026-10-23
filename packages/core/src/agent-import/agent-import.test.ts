import type { AgentImportFile } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../agent-skill.js";
import {
  AGENT_IMPORT_PROMPT,
  agentImportFolder,
  combineImportedInstructions,
  hasAgentImportSecrets,
  isAgentImportCandidate,
  parseAgentImport,
  readAgentImportConfig,
  readAgentImportFolder,
  resolveAgentImportNames,
  stripAgentImportSecrets,
} from "./index.js";

const skill = (name: string, description: string, body = "Steps.\n") =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 2\n---\n\n${body}`;

function plan(files: AgentImportFile[]) {
  const parsed = parseAgentImport(files);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("OpenClaw workspace", () => {
  const workspace: AgentImportFile[] = [
    { path: "workspace/AGENTS.md", content: "Keep replies short.\n" },
    { path: "workspace/SOUL.md", content: "# Soul\n\nCalm and direct.\n" },
    { path: "workspace/IDENTITY.md", content: "- **Name:** Pebble\n- **Emoji:** 🪨\n" },
    { path: "workspace/USER.md", content: "Prefers metric units.\n" },
    { path: "workspace/MEMORY.md", content: "Project Alpha ships in May.\n" },
    { path: "workspace/memory/2026-01-03.md", content: "Talked about the garden.\n" },
    { path: "workspace/memory/2026-01-02.md", content: "Planned the week.\n" },
    { path: "workspace/TOOLS.md", content: "Local tool notes.\n" },
    { path: "workspace/HEARTBEAT.md", content: "Check the inbox.\n" },
    { path: "workspace/skills/weekly-review/SKILL.md", content: skill("weekly-review", "Run it") },
    {
      path: "workspace/skills/home/garden/watering/SKILL.md",
      content: skill("watering", "Water the plants"),
    },
    { path: "workspace/.agents/skills/notes/SKILL.md", content: skill("notes", "Take notes") },
    { path: "workspace/skills/broken/SKILL.md", content: "No frontmatter here.\n" },
    { path: "workspace/sessions/2026-01-02.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/credentials/notes.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/logs/run.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/projects/readme.md", content: "Unrelated project notes.\n" },
  ];

  it("maps bootstrap files, daily memory and nested skills into one plan", () => {
    const result = plan(workspace);
    expect(result.source).toBe("openclaw");
    expect(result.suggestedName).toBe("Pebble");
    expect(result.instructions.map((item) => item.title)).toEqual([
      "SOUL.md",
      "AGENTS.md",
      "IDENTITY.md",
    ]);
    expect(result.memory.map((item) => [item.title, item.path])).toEqual([
      ["MEMORY.md", "MEMORY.md"],
      ["USER.md", "USER.md"],
      ["memory/2026-01-02.md", "memory/2026-01-02.md"],
      ["memory/2026-01-03.md", "memory/2026-01-03.md"],
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["notes", "watering", "weekly-review"]);
    const review = result.skills.find((item) => item.name === "weekly-review");
    expect(parseSkillMd(review!.content)).toMatchObject({
      name: "weekly-review",
      description: "Run it",
      frontmatter: { version: 2 },
    });
    expect(result.skipped).toEqual([
      { path: "HEARTBEAT.md", reason: "runtime" },
      { path: "TOOLS.md", reason: "runtime" },
      { path: "skills/broken/SKILL.md", reason: "invalid_skill" },
    ]);
  });

  it("never reads private runtime folders, even when they are sent", () => {
    const result = plan(workspace);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("EXAMPLE_KEY");
    expect(everything).not.toContain("Unrelated project notes");
  });

  it("gives every item a stable id", () => {
    const first = plan(workspace);
    const second = plan([...workspace].reverse());
    expect(second).toEqual(first);
    const ids = [...first.instructions, ...first.memory, ...first.skills].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the bot after a named workspace when it has no identity", () => {
    const result = plan([{ path: "workspace-research/SOUL.md", content: "Curious.\n" }]);
    expect(result.source).toBe("openclaw");
    expect(result.suggestedName).toBe("research");
  });
});

describe("Hermes home", () => {
  const home: AgentImportFile[] = [
    { path: ".hermes/SOUL.md", content: "Warm and precise.\n" },
    { path: ".hermes/HERMES.md", content: "Answer in English.\n" },
    {
      path: ".hermes/memories/MEMORY.md",
      content: "Deploys run on Fridays.\n§\n\n§\nThe staging host is slow.\nUse patience.\n",
    },
    { path: ".hermes/memories/USER.md", content: "Name is Sam.\n§\nLikes tea.\n" },
    {
      path: ".hermes/skills/devops/deploy-check/SKILL.md",
      content: skill("deploy-check", "Check a deploy"),
    },
    { path: ".hermes/sessions/session.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: ".hermes/cron/jobs.md", content: "EXAMPLE_KEY=placeholder\n" },
  ];

  it("splits entries, maps category skills and ignores private folders", () => {
    const result = plan(home);
    expect(result.source).toBe("hermes");
    expect(result.suggestedName).toBe("Hermes");
    expect(result.instructions.map((item) => item.title)).toEqual(["SOUL.md", "HERMES.md"]);
    expect(result.memory).toMatchObject([
      {
        title: "memories/MEMORY.md",
        path: "MEMORY.md",
        content: "Deploys run on Fridays.\n\nThe staging host is slow.\nUse patience.\n",
      },
      { title: "memories/USER.md", path: "USER.md", content: "Name is Sam.\n\nLikes tea.\n" },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["deploy-check"]);
    expect(JSON.stringify(result)).not.toContain("EXAMPLE_KEY");
  });

  it("is detected from its memory folder without a root folder name", () => {
    expect(plan([{ path: "memories/USER.md", content: "Likes tea.\n" }]).source).toBe("hermes");
  });
});

describe("any other agent document", () => {
  const document = [
    "Sure! Here is everything I know.",
    "",
    "````markdown",
    "# Name",
    "Atlas",
    "",
    "# Instructions",
    "Be concise.",
    "",
    "```bash",
    "# Skills",
    "echo inside a code block",
    "```",
    "",
    "# Memory",
    "Works remotely.",
    "",
    "## About me",
    "Lives near the coast.",
    "",
    "## Projects",
    "Building a boat.",
    "",
    "# Skills",
    "## trip-planner",
    "Description: Plan a trip",
    "1. Ask for dates.",
    "",
    "## no-description",
    "",
    "````",
    "",
    "Let me know if you need anything else.",
  ].join("\n");

  it("tolerates chatter and an outer code fence around the sections", () => {
    const result = plan([{ path: "agent.md", content: document }]);
    expect(result.source).toBe("document");
    expect(result.suggestedName).toBe("Atlas");
    expect(result.instructions).toEqual([
      {
        id: "instructions:Instructions",
        title: "Instructions",
        content: "Be concise.\n\n```bash\n# Skills\necho inside a code block\n```\n",
      },
    ]);
    expect(result.memory.map((item) => [item.title, item.path, item.content])).toEqual([
      ["MEMORY.md", "MEMORY.md", "Works remotely.\n"],
      ["About me", "about-me.md", "# About me\n\nLives near the coast.\n"],
      ["Projects", "projects.md", "# Projects\n\nBuilding a boat.\n"],
    ]);
    expect(result.skills).toHaveLength(1);
    expect(parseSkillMd(result.skills[0]!.content)).toMatchObject({
      name: "trip-planner",
      description: "Plan a trip",
      body: "1. Ask for dates.\n",
    });
    expect(result.skipped).toEqual([{ path: "Skills/no-description", reason: "invalid_skill" }]);
  });

  it("accepts a document with only some sections and no fence", () => {
    const result = plan([{ path: "reply.md", content: "# Memory\nLikes tea.\n" }]);
    expect(result.suggestedName).toBe("");
    expect(result.instructions).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.memory.map((item) => item.path)).toEqual(["MEMORY.md"]);
  });

  it("asks for the same sections the parser reads", () => {
    for (const heading of ["# Name", "# Instructions", "# Memory", "# Skills"]) {
      expect(AGENT_IMPORT_PROMPT).toContain(`\n${heading}\n`);
    }
  });
});

describe("detection", () => {
  it("rejects files it does not recognise", () => {
    expect(parseAgentImport([{ path: "notes/todo.md", content: "Buy milk.\n" }])).toEqual({
      error: "No OpenClaw, Hermes or agent document found.",
    });
    expect(parseAgentImport([{ path: "reply.md", content: "Just chatting.\n" }])).toHaveProperty(
      "error",
    );
  });

  it("only offers recognised files for upload", () => {
    expect(isAgentImportCandidate("SOUL.md")).toBe(true);
    expect(isAgentImportCandidate("memory/2026-01-02.md")).toBe(true);
    expect(isAgentImportCandidate("skills/a/b/SKILL.md")).toBe(true);
    expect(isAgentImportCandidate("sessions/today.md")).toBe(false);
    expect(isAgentImportCandidate("projects/readme.md")).toBe(false);
  });
});

describe("instructions", () => {
  it("joins several files under headings and keeps one file as written", () => {
    expect(combineImportedInstructions([{ title: "SOUL.md", content: "Calm.\n" }])).toBe("Calm.");
    expect(
      combineImportedInstructions([
        { title: "SOUL.md", content: "Calm.\n" },
        { title: "AGENTS.md", content: "Short.\n" },
      ]),
    ).toBe("# SOUL.md\n\nCalm.\n\n# AGENTS.md\n\nShort.");
  });

  it("reports the combined length so an oversized import can be refused", () => {
    const big = "x".repeat(BOT_INSTRUCTIONS_MAX_LENGTH);
    const result = plan([
      { path: "workspace/SOUL.md", content: big },
      { path: "workspace/AGENTS.md", content: "More.\n" },
    ]);
    expect(combineImportedInstructions(result.instructions).length).toBeGreaterThan(
      BOT_INSTRUCTIONS_MAX_LENGTH,
    );
  });
});

describe("name collisions", () => {
  it("picks free names for space memory and skills instead of overwriting", () => {
    const result = plan([
      { path: "workspace/MEMORY.md", content: "Facts.\n" },
      { path: "workspace/memory/2026-01-02.md", content: "Day.\n" },
      { path: "workspace/skills/a/SKILL.md", content: skill("Notes", "First") },
      { path: "workspace/skills/b/SKILL.md", content: skill("notes", "Second") },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["Notes", "notes-2"]);
    const resolved = resolveAgentImportNames(result, {
      spaceMemoryPaths: ["MEMORY.md", "MEMORY-2.md", "memory/2026-01-02.md"],
      skillNames: ["NOTES"],
    });
    expect(resolved.memory.map((item) => [item.path, item.spacePath])).toEqual([
      ["MEMORY.md", "MEMORY-3.md"],
      ["memory/2026-01-02.md", "memory/2026-01-02-2.md"],
    ]);
    expect(resolved.skills.map((item) => [item.title, item.name])).toEqual([
      ["Notes", "Notes-2"],
      ["notes", "notes-3"],
    ]);
    expect(parseSkillMd(resolved.skills[1]!.content)).toMatchObject({
      name: "notes-3",
      description: "Second",
    });
  });
});

describe("skill files", () => {
  const openclawSkill = [
    "---",
    "name: weather",
    "description: Get current weather and forecasts.",
    "homepage: https://example.test/weather",
    'metadata: {"openclaw":{"emoji":"🌤️","requires":{"bins":["curl"]}}}',
    "---",
    "",
    "# Weather",
    "",
    "Run `curl` against the forecast service.",
    "",
  ].join("\n");
  const hermesSkill = [
    "---",
    "name: arxiv",
    "description: Search and summarise papers.",
    "version: 1.0.0",
    "metadata:",
    "  hermes:",
    "    tags: [research, papers]",
    "required_environment_variables:",
    "  - name: EXAMPLE_KEY",
    "    prompt: Example key",
    "---",
    "",
    "## Steps",
    "1. Search.",
    "",
  ].join("\n");

  it("keeps SKILL.md exactly as written", () => {
    const openclaw = plan([
      { path: "workspace/SOUL.md", content: "Calm.\n" },
      { path: "workspace/skills/weather/SKILL.md", content: openclawSkill },
    ]);
    expect(openclaw.skills.map((item) => item.content)).toEqual([openclawSkill]);
    const hermes = plan([
      { path: ".hermes/SOUL.md", content: "Calm.\n" },
      { path: ".hermes/skills/research/arxiv/SKILL.md", content: hermesSkill },
    ]);
    expect(hermes.skills.map((item) => item.content)).toEqual([hermesSkill]);
  });

  it("normalises only a byte order mark and CRLF line endings", () => {
    const result = plan([
      {
        path: "workspace/skills/arxiv/SKILL.md",
        content: `\uFEFF${hermesSkill.replaceAll("\n", "\r\n")}`,
      },
    ]);
    expect(result.skills[0]!.content).toBe(hermesSkill);
  });

  it("renames by rewriting only the name line", () => {
    const result = plan([
      { path: "workspace/skills/weather/SKILL.md", content: openclawSkill },
      { path: "workspace/skills/arxiv/SKILL.md", content: hermesSkill },
    ]);
    const renamed = resolveAgentImportNames(result, {
      spaceMemoryPaths: [],
      skillNames: ["Weather", "arxiv", "arxiv-2"],
    });
    expect(renamed.skills.map((item) => [item.name, item.content])).toEqual([
      ["arxiv-3", hermesSkill.replace("name: arxiv\n", "name: arxiv-3\n")],
      ["weather-2", openclawSkill.replace("name: weather\n", "name: weather-2\n")],
    ]);
    const restored = resolveAgentImportNames(renamed, { spaceMemoryPaths: [], skillNames: [] });
    expect(restored.skills.map((item) => item.content)).toEqual([hermesSkill, openclawSkill]);
  });
});

describe("OpenClaw home folder", () => {
  const home = [
    ".openclaw/openclaw.json",
    ".openclaw/.env",
    ".openclaw/credentials/notes.md",
    ".openclaw/agents/main/sessions/today.md",
    ".openclaw/workspace/SOUL.md",
    ".openclaw/workspace/memory/2026-01-02.md",
    ".openclaw/workspace/skills/shared/SKILL.md",
    ".openclaw/workspace-research/SOUL.md",
    ".openclaw/skills/shared/SKILL.md",
    ".openclaw/skills/managed/SKILL.md",
  ];

  it("uses the main workspace plus managed skills and nothing else", () => {
    const folder = agentImportFolder(home);
    expect(folder.root).toBe("workspace");
    expect([...folder.files]).toEqual([
      [".openclaw/workspace/SOUL.md", "SOUL.md"],
      [".openclaw/workspace/memory/2026-01-02.md", "memory/2026-01-02.md"],
      [".openclaw/workspace/skills/shared/SKILL.md", "skills/shared/SKILL.md"],
      [".openclaw/openclaw.json", "openclaw.json"],
      [".openclaw/.env", ".env"],
      [".openclaw/skills/managed/SKILL.md", "skills/managed/SKILL.md"],
    ]);
  });

  it("uses the only named workspace, and none when there are several", () => {
    const named = agentImportFolder([
      ".openclaw/workspace-research/SOUL.md",
      ".openclaw/openclaw.json",
    ]);
    expect(named.root).toBe("workspace-research");
    expect([...named.files.values()]).toEqual(["SOUL.md", "openclaw.json"]);
    const several = [".openclaw/workspace-a/SOUL.md", ".openclaw/workspace-b/SOUL.md"];
    expect(agentImportFolder(several).files.size).toBe(0);
    expect(parseAgentImport(several.map((path) => ({ path, content: "Calm.\n" })))).toEqual({
      error: "No OpenClaw, Hermes or agent document found.",
    });
  });

  it("parses the files the folder choice keeps", () => {
    const files = home
      .filter((path) => path.endsWith(".md"))
      .map((path) => ({
        path,
        content: path.endsWith("SKILL.md")
          ? skill(path.split("/").at(-2)!, "Use it")
          : `From ${path}\n`,
      }));
    const result = plan(files);
    expect(result.source).toBe("openclaw");
    expect(result.instructions.map((item) => item.content)).toEqual([
      "From .openclaw/workspace/SOUL.md\n",
    ]);
    expect(result.memory.map((item) => item.path)).toEqual(["memory/2026-01-02.md"]);
    expect(result.skills.map((item) => item.name)).toEqual(["managed", "shared"]);
    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(JSON.stringify(result)).not.toContain("workspace-research");
  });
});

describe("real OpenClaw home tree", () => {
  it("reads only the workspace, managed skills and settings files", () => {
    const tree = [
      "openclaw.json",
      "openclaw.json.last-good",
      "openclaw.json.bak",
      "openclaw.json.bak.1",
      "config-journal-fingerprint.key",
      ".env",
      "cron/jobs.json",
      "agents/main/agent/AGENTS.md",
      "agents/main/sessions/today.md",
      "state/openclaw.sqlite",
      "migration/report.md",
      "media/outbound/note.md",
      "plugin-skills/canvas/SKILL.md",
      "cache/control-ui-assets/index.md",
      "tmp/agent-cli/notes.md",
      "credentials/notes.md",
      "workspace/.git/description",
      "workspace/.git/HEAD",
      "workspace/SOUL.md",
      "workspace/BOOTSTRAP.md",
      "workspace/IDENTITY.md",
      "workspace/memory/2026-10-20.md",
      "workspace/skills/garden/SKILL.md",
    ].map((path) => `.openclaw/${path}`);
    expect([...agentImportFolder(tree).files.values()]).toEqual([
      "SOUL.md",
      "BOOTSTRAP.md",
      "IDENTITY.md",
      "memory/2026-10-20.md",
      "skills/garden/SKILL.md",
      "openclaw.json",
      ".env",
      "cron/jobs.json",
    ]);
  });

  it("does not take the untouched identity template's hint as the name", () => {
    const template = [
      "# IDENTITY.md - Who Am I?",
      "",
      "- **Name:**",
      "  _(pick something you like)_",
      "- **Creature:**",
      "  _(AI? robot? familiar? ghost in the machine? something weirder?)_",
    ].join("\n");
    expect(plan([{ path: "workspace/IDENTITY.md", content: template }]).suggestedName).toBe(
      "OpenClaw",
    );
    expect(
      plan([{ path: "workspace/IDENTITY.md", content: "- **Name:** _(pick something you like)_" }])
        .suggestedName,
    ).toBe("OpenClaw");
  });
});

describe("Hermes bundled skills", () => {
  it("skips the skills Hermes installed itself", () => {
    const result = plan([
      { path: ".hermes/SOUL.md", content: "Direct.\n" },
      { path: ".hermes/skills/.bundled_manifest", content: "arxiv:abc123\ngithub:def456\n" },
      { path: ".hermes/skills/research/arxiv/SKILL.md", content: skill("arxiv", "Papers") },
      {
        path: ".hermes/skills/software-development/github/SKILL.md",
        content: skill("github", "PRs"),
      },
      { path: ".hermes/skills/mine/garden-log/SKILL.md", content: skill("garden-log", "Mine") },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["garden-log"]);
    expect(result.skipped).toEqual([
      { path: "skills/research/arxiv/SKILL.md", reason: "builtin" },
      { path: "skills/software-development/github/SKILL.md", reason: "builtin" },
    ]);
  });
});

describe("secret stripping", () => {
  const openclawJson = `{
    // JSON5, as OpenClaw allows
    agents: {
      defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
      entries: { main: { workspace: "/home/example/.openclaw/workspace", model: "x-ai/grok-4" } },
    },
    gateway: { auth: { token: "placeholder-gateway-token" } },
    channels: { telegram: { botToken: "placeholder-channel-token" } },
    env: { vars: { OPENROUTER_API_KEY: "placeholder-env-key" } },
    models: { providers: { anthropic: { apiKey: "placeholder-provider-key", headers: { "X-Key": "placeholder-provider-header" } } } },
    plugins: { entries: { search: { config: { apiKey: "placeholder-plugin-key" } } } },
    mcp: {
      servers: {
        docs: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer placeholder-header-token" },
          oauth: { clientSecret: "placeholder-client-secret" },
        },
        files: { command: "npx", args: ["-y", "server"], env: { EXAMPLE_TOKEN: "placeholder-env-token" } },
      },
    },
  }`;
  const hermesYaml = [
    "model:",
    "  default: anthropic/claude-sonnet-4.6",
    "  provider: openrouter",
    "  api_key: placeholder-model-key",
    "providers:",
    "  gemini:",
    "    api_key: placeholder-gemini-key",
    "    extra_headers: { X-Key: placeholder-extra-header }",
    "custom_providers:",
    "  - name: local",
    "    api_key: placeholder-custom-key",
    "mcp_servers:",
    "  docs:",
    "    url: https://mcp.example.com/mcp",
    "    headers:",
    "      Authorization: Bearer placeholder-header-token",
  ].join("\n");

  it("keeps what an import reads and no secret value", () => {
    const openclaw = stripAgentImportSecrets("openclaw.json", openclawJson);
    expect(openclaw).not.toMatch(/placeholder/);
    expect(readAgentImportConfig("openclaw.json", openclaw)).toEqual({
      agents: {
        defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
        entries: { main: { model: "x-ai/grok-4", workspace: "workspace" } },
        list: [],
      },
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: true,
            headers: { Authorization: "" },
            env: {},
          },
          files: {
            command: "npx",
            args: ["-y", "server"],
            headers: {},
            env: { EXAMPLE_TOKEN: "" },
          },
        },
      },
    });
    const hermes = stripAgentImportSecrets("config.yaml", hermesYaml);
    expect(hermes).not.toMatch(/placeholder/);
    expect(readAgentImportConfig("config.yaml", hermes)).toEqual({
      model: { default: "anthropic/claude-sonnet-4.6", provider: "openrouter" },
      mcp_servers: {
        docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "" }, env: {} },
      },
    });
  });

  it("drops secret files and unreadable settings, and leaves other files alone", () => {
    expect(stripAgentImportSecrets(".env", "OPENROUTER_API_KEY=placeholder")).toBe("");
    expect(stripAgentImportSecrets("auth.json", "{}")).toBe("");
    expect(stripAgentImportSecrets("openclaw.json", "{ not json")).toBe("");
    expect(stripAgentImportSecrets("cron/jobs.json", '{"jobs":[]}')).toBe('{"jobs":[]}');
  });

  it("tells whether the opt-in would add anything", () => {
    expect(hasAgentImportSecrets("openclaw.json", openclawJson)).toBe(true);
    expect(hasAgentImportSecrets("config.yaml", hermesYaml)).toBe(true);
    expect(
      hasAgentImportSecrets(
        "openclaw.json",
        stripAgentImportSecrets("openclaw.json", openclawJson),
      ),
    ).toBe(false);
    expect(hasAgentImportSecrets(".env", "A=1")).toBe(true);
    expect(hasAgentImportSecrets("cron/jobs.json", "{}")).toBe(false);
  });

  it("is applied on the server too unless the user opted in", () => {
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/openclaw.json", content: openclawJson },
      { path: ".openclaw/.env", content: "OPENROUTER_API_KEY=placeholder-env-key" },
    ];
    const without = readAgentImportFolder(files, { includeSecrets: false })!;
    expect([...without.files.keys()]).toEqual(["SOUL.md", "openclaw.json"]);
    expect(JSON.stringify([...without.files])).not.toMatch(/placeholder/);
    const opted = readAgentImportFolder(files, { includeSecrets: true })!;
    expect(opted.files.get(".env")).toBe("OPENROUTER_API_KEY=placeholder-env-key");
    expect(opted.files.get("openclaw.json")).toBe(openclawJson);
  });
});
