import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentImportPlan, Bot, MemoryDocument } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

const workspace = [
  { path: "workspace/SOUL.md", content: "Calm and direct.\n" },
  { path: "workspace/AGENTS.md", content: "Keep replies short.\n" },
  { path: "workspace/IDENTITY.md", content: "- **Name:** Pebble\n" },
  { path: "workspace/MEMORY.md", content: "Project Alpha ships in May.\n" },
  { path: "workspace/USER.md", content: "Prefers metric units.\n" },
  { path: "workspace/memory/2026-01-02.md", content: "Planned the week.\n" },
  { path: "workspace/TOOLS.md", content: "Local tool notes.\n" },
  { path: "workspace/skills/weekly-review/SKILL.md", content: skill("weekly-review", "Run it") },
  { path: "workspace/skills/watering/SKILL.md", content: skill("watering", "Water plants") },
  { path: "workspace/sessions/2026-01-02.md", content: "EXAMPLE_KEY=placeholder\n" },
];

/** An OpenClaw home shaped like the real one, with placeholder credentials. */
const settingsHome = [
  { path: ".openclaw/workspace/SOUL.md", content: "Calm and direct.\n" },
  {
    path: ".openclaw/openclaw.json",
    content: `{
      // JSON5, as written by OpenClaw
      agents: {
        entries: { main: { workspace: "/home/example/.openclaw/workspace" } },
        defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
      },
      gateway: { auth: { token: "placeholder-gateway-token" } },
      models: { providers: { anthropic: { apiKey: "\${ANTHROPIC_API_KEY}" } } },
      mcp: {
        servers: {
          docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer \${DOCS_TOKEN}" } },
          files: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { EXAMPLE_TOKEN: "placeholder-env-token" },
            toolFilter: { include: ["read_file"] },
          },
        },
      },
    }`,
  },
  {
    path: ".openclaw/.env",
    content: [
      "OPENROUTER_API_KEY=placeholder-openrouter-key",
      "ANTHROPIC_API_KEY=placeholder-anthropic-key",
      "DOCS_TOKEN=placeholder-docs-token",
      "TELEGRAM_BOT_TOKEN=placeholder-telegram-token",
    ].join("\n"),
  },
  {
    path: ".openclaw/cron/jobs.json",
    content: JSON.stringify({
      jobs: [
        {
          name: "heartbeat-main",
          declarationKey: "heartbeat:main",
          schedule: { kind: "every", everyMs: 1_800_000 },
          payload: { kind: "heartbeat" },
        },
        {
          name: "check",
          enabled: true,
          schedule: { kind: "every", everyMs: 1_800_000 },
          payload: { kind: "agentTurn", message: "Check the inbox" },
        },
        {
          name: "morning",
          enabled: false,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Kolkata" },
          payload: { kind: "agentTurn", message: "Summarise my day" },
        },
      ],
    }),
  },
];

describeIntegration("agent import", () => {
  let app: App;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-agent-import-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      // Offline: key checks and MCP endpoint checks never leave the test.
      modelConnectionFetch: async () => new Response("{}", { status: 200 }),
      remoteConnectors: {
        fetch: async () => new Response("", { status: 503 }),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("previews, then creates the bot with only the chosen items and no overwrites", async () => {
    const cookie = await signup(app, `import-${stamp}@rakazo.test`, "Import User");
    const existingSkill = await rpc<{ id: string; content: string }>(
      app,
      cookie,
      "agentSkills/create",
      { content: skill("weekly-review", "Existing") },
    );
    const anyBot = await rpc<Bot>(app, cookie, "bots/create", { name: "Existing" });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: anyBot.id },
      select: { spaceId: true, userId: true },
    });
    const spaceUser = await db.memoryDocument.create({
      data: { ...owner, scope: "user", botId: null, path: "USER.md", content: "Existing.\n" },
    });

    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: workspace,
    });
    expect(plan.source).toBe("openclaw");
    expect(plan.suggestedName).toBe("Pebble");
    expect(plan.skipped).toEqual([{ path: "TOOLS.md", reason: "runtime" }]);
    expect(plan.memory.find((item) => item.path === "USER.md")?.spacePath).toBe("USER-2.md");
    expect(plan.skills.map((item) => [item.title, item.name])).toEqual([
      ["watering", "watering"],
      ["weekly-review", "weekly-review-2"],
    ]);
    expect(JSON.stringify(plan)).not.toContain("EXAMPLE_KEY");

    const id = (title: string) =>
      [...plan.instructions, ...plan.memory, ...plan.skills].find((item) => item.title === title)!
        .id;
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files: workspace,
      name: "Pebble",
      computerMode: "team",
      selection: {
        instructions: [id("AGENTS.md"), id("SOUL.md")],
        memory: [
          { id: id("MEMORY.md"), destination: "bot" },
          { id: id("USER.md"), destination: "space" },
        ],
        skills: [id("weekly-review")],
      },
    });
    expect(bot.name).toBe("Pebble");
    expect(bot.instructions).toBe(
      "# SOUL.md\n\nCalm and direct.\n\n# AGENTS.md\n\nKeep replies short.",
    );

    const botMemory = await db.memoryDocument.findMany({
      where: { botId: bot.id },
      include: { revisions: true },
      orderBy: { path: "asc" },
    });
    expect(botMemory.map((doc) => [doc.scope, doc.path, doc.content])).toEqual([
      ["bot", "MEMORY.md", "Project Alpha ships in May.\n"],
    ]);
    expect(botMemory[0]!.revisions.map((revision) => revision.content)).toEqual([
      "Project Alpha ships in May.\n",
    ]);

    const spaceMemory = await db.memoryDocument.findMany({
      where: { ...owner, scope: "user", botId: null, path: { in: ["USER.md", "USER-2.md"] } },
      include: { revisions: true },
      orderBy: { path: "asc" },
    });
    expect(spaceMemory.map((doc) => [doc.path, doc.content, doc.revisions.length])).toEqual([
      ["USER-2.md", "Prefers metric units.\n", 1],
      ["USER.md", "Existing.\n", 0],
    ]);
    expect(spaceMemory.find((doc) => doc.path === "USER.md")?.id).toBe(spaceUser.id);

    const skills = await db.agentSkill.findMany({ where: owner, orderBy: { name: "asc" } });
    expect(skills.map((row) => row.name)).toEqual(["weekly-review", "weekly-review-2"]);
    expect(skills[0]!.content).toBe(existingSkill.content);
    expect(skills.some((row) => row.name === "watering")).toBe(false);
    expect(
      await db.memoryDocument.count({ where: { ...owner, path: "memory/2026-01-02.md" } }),
    ).toBe(0);
  });

  it("refuses unknown selections and oversized instructions without creating a bot", async () => {
    const cookie = await signup(app, `import-reject-${stamp}@rakazo.test`, "Reject User");
    const before = await rpc<Bot[]>(app, cookie, "bots/list", {});
    const unknown = await raw(app, cookie, "bots/importCreate", {
      files: workspace,
      name: "Nope",
      selection: { instructions: ["instructions:secret.md"], memory: [], skills: [] },
    });
    expect(unknown.status).toBe(400);
    const big = [
      { path: "workspace/SOUL.md", content: "x".repeat(15_000) },
      { path: "workspace/AGENTS.md", content: "y".repeat(15_000) },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files: big });
    const tooLong = await raw(app, cookie, "bots/importCreate", {
      files: big,
      name: "Nope",
      selection: { instructions: plan.instructions.map((item) => item.id), memory: [], skills: [] },
    });
    expect(tooLong.status).toBe(400);
    const unrecognised = await raw(app, cookie, "bots/importPreview", {
      files: [{ path: "notes.md", content: "Just notes.\n" }],
    });
    expect(unrecognised.status).toBe(400);
    expect(await rpc<Bot[]>(app, cookie, "bots/list", {})).toHaveLength(before.length);
  });

  it("keeps imported curated memory in the bot's context when daily logs are large", async () => {
    const cookie = await signup(app, `import-memory-${stamp}@rakazo.test`, "Memory User");
    const days = Array.from({ length: 5 }, (_, index) => ({
      path: `workspace/memory/2026-01-0${index + 1}.md`,
      content: `Day ${index + 1}. ${"Notes. ".repeat(1_500)}\n`,
    }));
    const files = [
      { path: "workspace/MEMORY.md", content: "Curated: Project Alpha ships in May.\n" },
      { path: "workspace/USER.md", content: "Curated: prefers metric units.\n" },
      ...days,
    ];
    expect(days.reduce((sum, day) => sum + day.content.length, 0)).toBeGreaterThan(32 * 1024);
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files });
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      name: "Memory",
      selection: {
        instructions: [],
        memory: plan.memory.map((item) => ({ id: item.id, destination: "bot" })),
        skills: [],
      },
    });

    const documents = await db.memoryDocument.findMany({ where: { botId: bot.id } });
    const updated = (path: string) =>
      documents.find((doc) => doc.path === path)!.updatedAt.getTime();
    const newestDay = Math.max(...days.map((day) => updated(day.path.slice("workspace/".length))));
    expect(updated("USER.md")).toBeGreaterThan(newestDay);
    expect(updated("MEMORY.md")).toBeGreaterThan(updated("USER.md"));
    expect(updated("memory/2026-01-05.md")).toBeGreaterThan(updated("memory/2026-01-01.md"));

    const { MarkdownMemoryStore } = await import("../../memory/src/index.ts");
    const { loadAgentMemoryContext } = await import("../../adapters/src/memory-context.ts");
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true },
    });
    const context = await loadAgentMemoryContext(new MarkdownMemoryStore(db), bot.id, {
      operationId: "agent-import-test",
      traceId: "agent-import-test",
      ...owner,
      signal: new AbortController().signal,
    });
    expect(context).toContain("Curated: Project Alpha ships in May.");
    expect(context).toContain("Curated: prefers metric units.");
  });

  it("imports model, MCP servers, routines and opted-in API keys through the existing paths", async () => {
    const cookie = await signup(app, `import-settings-${stamp}@rakazo.test`, "Settings User");
    const firstBot = await rpc<Bot>(app, cookie, "bots/create", { name: "First" });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: firstBot.id },
      select: { spaceId: true, userId: true },
    });
    await db.user.update({ where: { id: owner.userId }, data: { timezone: "Europe/Berlin" } });
    await rpc(app, cookie, "models/connect", {
      provider: "anthropic",
      apiKey: "placeholder-existing-key",
    });
    const existing = await db.userModelCredential.findFirstOrThrow({
      where: { userId: owner.userId, provider: "anthropic" },
    });

    const preview = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
    });
    expect(JSON.stringify(preview)).not.toContain("placeholder-");
    expect(preview.model).toEqual({
      id: "model",
      title: "openrouter/anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.6",
      status: "needs_key",
    });
    expect(preview.apiKeys).toEqual([]);
    expect(preview.mcpServers.map((item) => item.name)).toEqual(["docs", "files"]);
    expect(preview.routines.map((item) => [item.title, item.content])).toEqual([
      ["check", "*/30 * * * * (Europe/Berlin)\n\nCheck the inbox"],
      ["morning", "0 9 * * * (Asia/Kolkata)\n\nSummarise my day"],
    ]);
    expect(preview.skipped).toContainEqual({
      path: "cron/jobs.json: heartbeat-main",
      reason: "builtin",
    });

    const opted = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
      includeSecrets: true,
    });
    expect(JSON.stringify(opted)).not.toContain("placeholder-");
    expect(opted.apiKeys.map((item) => item.provider)).toEqual(["openrouter"]);
    expect(opted.skipped).toContainEqual({ path: "openclaw.json", reason: "connected" });

    expect(opted.model?.status).toBe("needs_key");

    // A model that cannot be used yet is refused before anything is written.
    const botsBefore = await db.bot.count({ where: owner });
    const refused = await raw(app, cookie, "bots/importCreate", {
      files: settingsHome,
      name: "Refused",
      selection: {
        instructions: [],
        memory: [],
        skills: [],
        model: true,
        mcpServers: preview.mcpServers.map((item) => item.id),
        routines: preview.routines.map((item) => item.id),
      },
    });
    expect(refused.status).toBe(400);
    expect(await db.bot.count({ where: owner })).toBe(botsBefore);
    expect(await db.mcpServer.count({ where: owner })).toBe(0);
    expect(await db.routine.count({ where: owner })).toBe(0);

    const defaultBefore = await db.spaceModelPreference.findFirstOrThrow({
      where: { ...owner, isDefault: true },
    });
    expect(defaultBefore.credentialId).toBe(existing.id);

    const response = await raw(app, cookie, "bots/importCreate", {
      files: settingsHome,
      includeSecrets: true,
      name: "Settings",
      selection: {
        instructions: opted.instructions.map((item) => item.id),
        memory: [],
        skills: [],
        model: true,
        mcpServers: opted.mcpServers.map((item) => item.id),
        routines: opted.routines.map((item) => item.id),
        apiKeys: opted.apiKeys.map((item) => item.id),
      },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("placeholder-");
    const bot = (JSON.parse(text) as { json: Bot }).json;
    expect([bot.modelProvider, bot.modelId]).toEqual(["openrouter", "anthropic/claude-sonnet-4.6"]);

    // Keys go through the connection path: encrypted, and an existing one is kept.
    const credentials = await db.userModelCredential.findMany({ where: { userId: owner.userId } });
    expect(credentials.map((row) => row.provider).sort()).toEqual(["anthropic", "openrouter"]);
    expect(credentials.find((row) => row.provider === "anthropic")?.secretId).toBe(
      existing.secretId,
    );
    // The imported key is added without switching the user's default model.
    const defaults = await db.spaceModelPreference.findMany({
      where: { ...owner, isDefault: true },
    });
    expect(defaults.map((row) => row.credentialId)).toEqual([existing.id]);
    const imported = credentials.find((row) => row.provider === "openrouter")!;
    expect(
      await db.spaceModelPreference.findFirst({ where: { ...owner, credentialId: imported.id } }),
    ).toMatchObject({ isDefault: false });
    const secrets = await db.secret.findMany({ where: { userId: owner.userId } });
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(secret.ciphertext).not.toContain("placeholder-");

    const servers = await db.mcpServer.findMany({
      where: owner,
      include: { assignments: true },
      orderBy: { slug: "asc" },
    });
    expect(
      servers.map((row) => [row.slug, row.transport, row.headers, row.env, Boolean(row.secretId)]),
    ).toEqual([
      ["docs", "streamable_http", { Authorization: true }, {}, true],
      ["files", "stdio", {}, { EXAMPLE_TOKEN: true }, true],
    ]);
    expect(
      servers.map((row) =>
        row.assignments.map((link) => [link.botId, link.allowAllTools, link.allowedTools]),
      ),
    ).toEqual([[[bot.id, true, []]], [[bot.id, false, ["read_file"]]]]);

    const routines = await db.routine.findMany({
      where: { botId: bot.id },
      orderBy: { name: "asc" },
    });
    expect(
      routines.map((row) => [
        row.name,
        row.crons,
        row.timezone,
        row.active,
        Boolean(row.nextRunAt),
      ]),
    ).toEqual([
      ["check", ["*/30 * * * *"], "Europe/Berlin", true, true],
      ["morning", ["0 9 * * *"], "Asia/Kolkata", false, false],
    ]);

    // Without the opt-in, servers come without credentials and existing slugs are kept.
    const again = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
    });
    expect(again.mcpServers.map((item) => [item.title, item.name])).toEqual([
      ["docs", "docs-2"],
      ["files", "files-2"],
    ]);
    await rpc<Bot>(app, cookie, "bots/importCreate", {
      files: settingsHome,
      name: "Settings again",
      selection: {
        instructions: [],
        memory: [],
        skills: [],
        mcpServers: again.mcpServers.map((item) => item.id),
      },
    });
    const plain = await db.mcpServer.findMany({
      where: { ...owner, slug: { in: ["docs-2", "files-2"] } },
      orderBy: { slug: "asc" },
    });
    expect(plain.map((row) => [row.slug, row.headers, row.env, row.secretId])).toEqual([
      ["docs-2", {}, {}, null],
      ["files-2", {}, {}, null],
    ]);

    // Another user sees none of it.
    const other = await signup(app, `import-settings-other-${stamp}@rakazo.test`, "Other");
    expect(await rpc<unknown[]>(app, other, "mcp/servers/list", {})).toEqual([]);
    expect(await rpc<unknown[]>(app, other, "models/credentials", {})).toEqual([]);
    expect((await raw(app, other, "routines/list", { botId: bot.id })).status).not.toBe(200);
  });

  it("keeps each import inside the actor's own space", async () => {
    const ownerCookie = await signup(app, `import-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `import-other-${stamp}@rakazo.test`, "Other");
    await rpc(app, ownerCookie, "agentSkills/create", { content: skill("watering", "Owner") });

    const otherPlan = await rpc<AgentImportPlan>(app, otherCookie, "bots/importPreview", {
      files: workspace,
    });
    expect(otherPlan.skills.map((item) => item.name)).toEqual(["watering", "weekly-review"]);

    const ownerPlan = await rpc<AgentImportPlan>(app, ownerCookie, "bots/importPreview", {
      files: workspace,
    });
    const memoryId = ownerPlan.memory.find((item) => item.path === "USER.md")!.id;
    const ownerBot = await rpc<Bot>(app, ownerCookie, "bots/importCreate", {
      files: workspace,
      name: "Owner bot",
      selection: {
        instructions: [],
        memory: [{ id: memoryId, destination: "space" }],
        skills: ownerPlan.skills.map((item) => item.id),
      },
    });

    expect((await raw(app, otherCookie, "bots/get", { botId: ownerBot.id })).status).not.toBe(200);
    const otherMemory = await rpc<MemoryDocument[]>(app, otherCookie, "memory/list", {});
    expect(otherMemory.some((doc) => doc.content === "Prefers metric units.\n")).toBe(false);
    const otherSkills = await rpc<{ name: string }[]>(app, otherCookie, "agentSkills/list", {});
    expect(otherSkills.some((item) => item.name === "watering")).toBe(false);
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
}
