import type { AgentImportFile } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { combineImportedInstructions, isAgentHome, parseAgentImport } from "./index.js";
import { openClawRuntimeMentions, parseOpenClawIdentity } from "./openclaw.js";
import { isHermesDefault, isOpenClawDefault } from "./stock.js";

// Unchanged files as OpenClaw and Hermes write them for a new agent (OpenClaw's templates are
// published in its docs; Hermes writes this SOUL.md).
const OPENCLAW_SOUL =
  "# SOUL.md - Who You Are\n\n_You're not a chatbot. You're becoming someone._\n\nWant a sharper version? See [SOUL.md personality guide](/concepts/soul).\n\n## Core Truths\n\n**Be genuinely helpful, not performatively helpful.** Skip the \"Great question!\" and \"I'd be happy to help!\" — just help.\n\n**Have opinions.** Disagree, prefer things, find stuff amusing or boring. No personality is just a search engine with extra steps.\n\n**Be resourceful before asking.** Read the file, check the context, search for it. Come back with answers, not questions.\n\n**Earn trust through competence.** Do what you're asked, fully. Check before public or outbound actions nobody asked for.\n\n**Remember you're a guest.** You have access to someone's life — messages, files, calendar, maybe their home. Treat it with respect.\n\n## Boundaries\n\n";
const OPENCLAW_AGENTS =
  "# AGENTS.md - Your Workspace\n\nKeep workspace conventions here. Personality and tone belong in `SOUL.md`.\n\n## First Run\n\nIf `BOOTSTRAP.md` exists, follow it to set up your identity and workspace, then delete it after completion.\n\n## Session Startup\n\nUse runtime-provided startup context first. It may already include `AGENTS.md`, `SOUL.md`, `USER.md`, recent daily memory (`memory/YYYY-MM-DD.md`), and `MEMORY.md` (main session only).\n\nRead startup files again only when:\n\n1. The user explicitly asks.\n";
const OPENCLAW_USER =
  "# USER.md - User Model\n\nStore stable user preferences and profile facts as directives that can guide future sessions.\n\nUse one directive per entry:\n\n```md\n<!-- observed: YYYY-MM-DD | status: active -->\n\n- Prefer concise progress updates during implementation work.\n```\n\n- Begin each directive with an imperative such as `Always`, `Never`, or `Prefer`.\n- Record the observation date and either `active` or `superseded` on the metadata line.\n- When a preference changes, mark the old entry `superseded` and rewrite the active directive in place. Never append a contradictory active directive.\n- Keep stable communication style, relationships, and active-project context here. Put durable non-profile facts and decisions in `MEMORY.md`.\n- Save this file at the workspace root as `USER.md`. It loads every session with a separate 4,000-character budget.\n\n## Directives\n\nReplace the example below with a real directive and a real observation date before you save this file. Never leave a placeholder directive `active`.\n\n<!-- observed: YYYY-MM-DD | status: active -->\n\n- Prefer ...\n\n## Related\n\n- [Agent workspace](/concepts/agent-workspace)\n\n";
const HERMES_SOUL =
  "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler (\"Great question,\" \"I'd be happy to\"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or the stakes demand it, not by default.";

function plan(files: AgentImportFile[]) {
  const parsed = parseAgentImport(files);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("defaults the source wrote", () => {
  it("recognises OpenClaw's templates and Hermes' SOUL.md, unchanged", () => {
    expect(isOpenClawDefault("SOUL.md", OPENCLAW_SOUL)).toBe(true);
    expect(isOpenClawDefault("AGENTS.md", OPENCLAW_AGENTS)).toBe(true);
    expect(isOpenClawDefault("USER.md", OPENCLAW_USER)).toBe(true);
    expect(isHermesDefault(HERMES_SOUL)).toBe(true);
  });

  it("tolerates one changed line from another template version, and frontmatter", () => {
    expect(isOpenClawDefault("SOUL.md", `${OPENCLAW_SOUL}\nA line from a newer version.\n`)).toBe(
      true,
    );
    expect(isOpenClawDefault("SOUL.md", `---\ntitle: x\n---\n${OPENCLAW_SOUL}`)).toBe(true);
  });

  it("treats a file the user wrote in as theirs", () => {
    expect(
      isOpenClawDefault("SOUL.md", `${OPENCLAW_SOUL}\nAlways answer in Dutch.\nNever use emoji.\n`),
    ).toBe(false);
    // USER.md allows no change: any added line is something the user said about themselves.
    expect(isOpenClawDefault("USER.md", `${OPENCLAW_USER}\n- Name: Example User\n`)).toBe(false);
    expect(isOpenClawDefault("SOUL.md", "Calm and direct.\n")).toBe(false);
    expect(isHermesDefault(`${HERMES_SOUL} Always answer in Dutch. Sign off as Atlas.`)).toBe(
      false,
    );
    expect(isHermesDefault("You are Atlas, a careful research assistant.")).toBe(false);
  });

  it("starts defaults unticked in the plan, with the reason", () => {
    const openclaw = plan([
      { path: "workspace/SOUL.md", content: OPENCLAW_SOUL },
      { path: "workspace/AGENTS.md", content: OPENCLAW_AGENTS },
      { path: "workspace/USER.md", content: OPENCLAW_USER },
      { path: "workspace/MEMORY.md", content: "Project Alpha ships in May.\n" },
    ]);
    expect(openclaw.instructions.map((item) => [item.title, item.stock])).toEqual([
      ["SOUL.md", true],
      ["AGENTS.md", true],
    ]);
    expect(openclaw.memory.map((item) => [item.title, item.stock])).toEqual([
      ["MEMORY.md", false],
      ["USER.md", true],
    ]);
    const hermes = plan([
      { path: ".hermes/SOUL.md", content: HERMES_SOUL },
      { path: ".hermes/config.yaml", content: "model:\n  provider: openrouter\n" },
    ]);
    expect(hermes.instructions.map((item) => [item.title, item.role, item.stock])).toEqual([
      ["SOUL.md", "persona", true],
    ]);
  });
});

describe("OpenClaw files by purpose", () => {
  it("composes a customised SOUL and AGENTS as persona then working instructions", () => {
    const result = plan([
      {
        path: "workspace/AGENTS.md",
        content: "# AGENTS.md - Your Workspace\n\nKeep replies short.\n",
      },
      { path: "workspace/SOUL.md", content: "# SOUL.md - Who You Are\n\nCalm and direct.\n" },
      { path: "workspace/IDENTITY.md", content: "- Name: Pebble\n- Vibe: warm\n- Avatar: a.png\n" },
    ]);
    expect(combineImportedInstructions(result.instructions)).toBe(
      "# Persona\n\nCalm and direct.\n\n# Working instructions\n\nKeep replies short.",
    );
    expect([result.suggestedName, result.suggestedDescription]).toEqual(["Pebble", "warm"]);
    expect(result.instructions.some((item) => item.title === "IDENTITY.md")).toBe(false);
    expect(result.skipped).toContainEqual({ path: "IDENTITY.md: Avatar", reason: "runtime" });
  });

  it("reads IDENTITY.md as OpenClaw does", () => {
    expect(
      parseOpenClawIdentity(
        "- **Name:** Pebble\n- **Theme:** lighthouse keeper\n- **Creature:** owl\n- **Emoji:**\n  _(your signature — pick one that feels right)_\n",
      ),
    ).toEqual({ name: "Pebble", description: "lighthouse keeper", unused: [] });
    expect(parseOpenClawIdentity("- name: _(pick something you like)_\n- EMOJI: 🦉")).toEqual({
      unused: ["Emoji"],
    });
  });

  it("flags where a customised AGENTS.md relies on OpenClaw's runtime, keeping the text", () => {
    const custom = [
      "# House rules",
      "",
      "Answer briefly.",
      "",
      "## First Run",
      "",
      "If `BOOTSTRAP.md` exists, follow it.",
      "",
      "## Session Startup",
      "",
      "Read `memory/YYYY-MM-DD.md` for today.",
      "",
      "## 💓 Heartbeats - Be Proactive",
      "",
      "Check HEARTBEAT.md when polled.",
    ].join("\n");
    expect(openClawRuntimeMentions(custom)).toEqual([
      "First Run",
      "BOOTSTRAP.md",
      "Session Startup",
      "memory/YYYY-MM-DD.md",
      "💓 Heartbeats - Be Proactive",
      "HEARTBEAT.md",
    ]);
    const result = plan([{ path: "workspace/AGENTS.md", content: custom }]);
    expect(result.instructions[0]).toMatchObject({ stock: false, content: custom });
    expect(result.instructions[0]!.mentions).toContain("Session Startup");
    expect(openClawRuntimeMentions("Answer briefly. Keep a daily log.")).toEqual([]);
  });
});

describe("skill status", () => {
  const skill = (front: string) =>
    plan([
      {
        path: "workspace/skills/notes/SKILL.md",
        content: `---\nname: notes\ndescription: Take notes\n${front}---\n\nSteps.\n`,
      },
    ]).skills[0]!.status;

  it("is ready, needs what the skill declares, or is not supported on another platform", () => {
    expect(skill("")).toEqual({ kind: "ready" });
    expect(
      skill(
        "metadata:\n  openclaw:\n    requires:\n      bins: [gh, curl]\n      env: [GH_TOKEN]\n",
      ),
    ).toEqual({
      kind: "needs_setup",
      needs: [{ kind: "requires", names: ["gh", "curl", "GH_TOKEN"] }],
    });
    expect(skill("platforms: [macos]\n")).toEqual({
      kind: "unsupported",
      reason: "other_platform",
    });
  });
});

describe("recognising a dropped agent by its file names", () => {
  it("knows OpenClaw and Hermes homes and workspaces, not ordinary projects", () => {
    expect(isAgentHome(["home/openclaw.json", "home/workspace/AGENTS.md"])).toBe(true);
    expect(isAgentHome(["workspace/SOUL.md", "workspace/MEMORY.md"])).toBe(true);
    expect(isAgentHome(["hermes/config.yaml", "hermes/memories/MEMORY.md"])).toBe(true);
    expect(isAgentHome([".hermes/SOUL.md"])).toBe(true);
    // A code project with an AGENTS.md for its coding agent is not an agent home.
    expect(isAgentHome(["repo/AGENTS.md", "repo/src/index.ts", "repo/README.md"])).toBe(false);
    expect(isAgentHome(["photos/beach.jpg"])).toBe(false);
  });
});
