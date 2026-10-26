import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, gzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AgentImportInfo, AgentImportPlan, Bot, MemoryDocument } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  clickAndWaitForRpc,
  completeOnboarding,
  expandAdvancedSection,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

function writeFolder(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** A synthetic OpenClaw workspace, written at run time so the repo holds no agent files. */
const workspaceFiles: Record<string, string> = {
  "SOUL.md": "Calm and direct.\n",
  "AGENTS.md": "Check the calendar before suggesting a time.\n",
  "IDENTITY.md": "- **Name:** Pebble\n- **Vibe:** calm and practical\n- **Emoji:** 🪨\n",
  "MEMORY.md": "The garden project starts in spring.\n",
  "USER.md": "Prefers metric units.\n",
  "TOOLS.md": "Local tool notes.\n",
  "skills/weekly-review/SKILL.md": skill("weekly-review", "Review the week"),
  "notes.txt": "Not Markdown.\n",
};

/** A synthetic OpenClaw home: the main workspace, another agent's, managed skills and secrets. */
const homeFiles: Record<string, string> = {
  "openclaw.json": `{
  // JSON5, as OpenClaw writes it
  agents: { defaults: { model: { primary: "deepseek/deepseek-flash" } } },
  gateway: { auth: { token: "placeholder-gateway-token" } },
  channels: { telegram: { botToken: "placeholder-channel-token" } },
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer placeholder-header-token" },
      },
      files: { command: "npx", args: ["-y", "example-files-server"] },
    },
  },
}
`,
  ".env": [
    "# OpenClaw environment",
    "TERMINAL_TIMEOUT=60",
    "TELEGRAM_BOT_TOKEN=placeholder-telegram",
    "DEEPSEEK_API_KEY=placeholder-deepseek-key",
  ].join("\n"),
  "workspace/skills/cleanup/SKILL.md":
    "---\nname: cleanup\ndescription: Clean the build\n---\n\n```bash\nrm -rf build\n```\n",
  "openclaw.json.bak": '{ "gateway": { "auth": { "token": "placeholder-backup-token" } } }\n',
  "credentials/notes.md": "EXAMPLE_KEY=placeholder\n",
  "workspace/SOUL.md": "Home soul.\n",
  "workspace/MEMORY.md": "Home memory.\n",
  "workspace-other/SOUL.md": "Other agent.\n",
  "skills/inbox-triage/SKILL.md": skill("inbox-triage", "Sort the inbox"),
};

const document = [
  "Here is the document.",
  "",
  "````markdown",
  "# Name",
  "Atlas",
  "",
  "# Instructions",
  "Be concise.",
  "",
  "# Memory",
  "Works remotely.",
  "",
  "## About me",
  "Lives near the coast.",
  "",
  "# Skills",
  "## trip-planner",
  "Plan a trip",
  "1. Ask for dates.",
  "````",
].join("\n");

async function openImport(page: Page) {
  await openNewBot(page);
  await page.getByTestId("create-bot-dialog").getByTestId("create-bot-import").click();
  const panel = page.getByTestId("agent-import");
  await expect(panel.getByTestId("agent-import-choose")).toBeVisible();
  return panel;
}

test("imports an OpenClaw folder and another assistant's document as new bots", async ({
  page,
  context,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `agent-import-${stamp}@rakazo.test`, "password12", "Import User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Import in the New bot dialog swaps the dialog for the import panel; Back swaps it back.
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByTestId("create-bot-import").click();
  const importPanel = page.getByTestId("agent-import");
  await expect(importPanel.getByTestId("agent-import-choose")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await importPanel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importPanel).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const panel = await openImport(page);
  const choose = panel.getByTestId("agent-import-choose");
  await expect(choose.getByRole("heading")).toHaveText(["OpenClaw or Hermes", "Another assistant"]);
  await expect(choose.getByRole("button")).toHaveText([
    "Choose folder",
    "Choose backup",
    "Copy prompt",
    "Continue",
    "Choose file",
  ]);
  await captureScreenshot(page, testInfo, "agent-import-choose");

  await choose.getByRole("textbox", { name: "Paste the reply" }).fill("Just chatting.");
  await choose.getByRole("button", { name: "Continue" }).click();
  await expect(panel.getByRole("alert")).toHaveText("No OpenClaw, Hermes or agent document found.");
  await captureScreenshot(page, testInfo, "agent-import-error");

  const home = testInfo.outputPath("openclaw-home");
  writeFolder(home, homeFiles);
  const homeRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await choose.getByTestId("agent-import-folder").setInputFiles(home);
  const homeBody = (await homeRequest).postData() ?? "";
  const sent = (JSON.parse(homeBody) as { json: { files: { path: string }[] } }).json;
  expect(sent.files.map((file) => file.path).sort()).toEqual([
    "openclaw-home/openclaw.json",
    "openclaw-home/skills/inbox-triage/SKILL.md",
    "openclaw-home/workspace/MEMORY.md",
    "openclaw-home/workspace/SOUL.md",
    "openclaw-home/workspace/skills/cleanup/SKILL.md",
  ]);
  // Without the opt-in, no credential value leaves the browser.
  expect(homeBody).not.toContain("placeholder-");
  const homePreview = panel.getByTestId("agent-import-preview");
  for (const [section, names] of [
    ["agent-import-instructions", ["SOUL.md"]],
    ["agent-import-memory", ["MEMORY.md"]],
    ["agent-import-skills", ["cleanup", "inbox-triage"]],
  ] as const) {
    const boxes = homePreview.getByTestId(section).getByRole("checkbox");
    await expect(boxes).toHaveCount(names.length);
    for (const [index, name] of names.entries()) {
      await expect(boxes.nth(index)).toHaveAccessibleName(name);
    }
  }
  // Skills, MCP servers and routines all start unticked: each needs the user's tick. Items
  // that may not work here also say why.
  const skills = homePreview.getByTestId("agent-import-skills");
  await expect(skills.getByRole("checkbox", { name: "cleanup" })).not.toBeChecked();
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).not.toBeChecked();
  // Each item has one status: Ready, what it needs, to review first, or not supported.
  await expect(skills.getByText("Contains code to run", { exact: true })).toBeVisible();
  // A ready item needs no label: the checkbox says enough.
  await expect(homePreview.getByText("Ready", { exact: true })).toHaveCount(0);
  const mcp = homePreview.getByTestId("agent-import-mcp");
  await expect(mcp.getByRole("checkbox", { name: "docs" })).not.toBeChecked();
  await expect(mcp.getByText("Credentials: Authorization", { exact: true })).toBeVisible();
  await expect(mcp.getByRole("checkbox", { name: "files" })).toBeDisabled();
  await expect(mcp.getByText("Not supported in Rakazo", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-compatibility");
  // Choices made before the opt-in survive it, in both directions.
  const nameBox = homePreview.getByRole("textbox", { name: "Name" });
  await nameBox.fill("Home bot");
  await skills.getByRole("checkbox", { name: "inbox-triage" }).click();
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await homePreview
    .getByTestId("agent-import-instructions")
    .getByRole("button", { name: "SOUL.md", exact: true })
    .click();
  await expect(
    homePreview.getByTestId("agent-import-instructions").getByTestId("agent-import-content"),
  ).toHaveText("Home soul.");
  const model = homePreview.getByTestId("agent-import-model");
  const modelBox = model.getByRole("checkbox", {
    name: "deepseek/deepseek-flash",
  });
  await expect(modelBox).toBeDisabled();
  await expect(model.getByText("API key for DeepSeek", { exact: true })).toBeVisible();
  const keys = homePreview.getByTestId("agent-import-keys");
  const optIn = keys.getByRole("checkbox", { name: "Include API keys" });
  await expect(optIn).not.toBeChecked();
  const optedRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await optIn.click();
  const optedBody = (await optedRequest).postData() ?? "";
  const opted = (
    JSON.parse(optedBody) as {
      json: { includeSecrets: boolean; files: { path: string; content: string }[] };
    }
  ).json;
  expect(opted.includeSecrets).toBe(true);
  // Only the model-provider key leaves the browser; no other secret or setting does.
  expect(opted.files.find((file) => file.path === "openclaw-home/.env")?.content).toBe(
    "DEEPSEEK_API_KEY=placeholder-deepseek-key\n",
  );
  for (const secret of [
    "placeholder-gateway-token",
    "placeholder-channel-token",
    "placeholder-telegram",
    "placeholder-header-token",
    "TERMINAL_TIMEOUT",
  ]) {
    expect(optedBody).not.toContain(secret);
  }
  await expect(optIn).toBeChecked();
  await expect(keys.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(keys.getByRole("checkbox", { name: "DeepSeek" })).toBeChecked();
  await expect(modelBox).toBeEnabled();
  await expect(modelBox).toBeChecked();
  await expect(homePreview).not.toContainText("placeholder-");
  await captureScreenshot(page, testInfo, "agent-import-preview-settings");
  await expect(nameBox).toHaveValue("Home bot");
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await optIn.click();
  await expect(optIn).not.toBeChecked();
  await expect(keys.getByRole("heading", { name: "API keys" })).toHaveCount(0);
  await expect(nameBox).toHaveValue("Home bot");
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await expect(skills.getByRole("checkbox", { name: "cleanup" })).not.toBeChecked();
  await panel.getByRole("button", { name: "Back", exact: true }).click();

  const workspace = testInfo.outputPath("workspace");
  writeFolder(workspace, workspaceFiles);
  await choose.getByTestId("agent-import-folder").setInputFiles(workspace);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(preview.getByRole("heading")).toHaveText([
    "Instructions",
    "Memory",
    "Skills",
    "Not imported",
  ]);
  // Instructions and memory start ticked; a skill waits for the user's tick.
  for (const [section, names, ticked] of [
    ["agent-import-instructions", ["SOUL.md", "AGENTS.md"], true],
    ["agent-import-memory", ["MEMORY.md", "USER.md"], true],
    ["agent-import-skills", ["weekly-review"], false],
  ] as const) {
    const boxes = preview.getByTestId(section).getByRole("checkbox");
    await expect(boxes).toHaveCount(names.length);
    for (const [index, name] of names.entries()) {
      await expect(boxes.nth(index)).toHaveAccessibleName(name);
      if (ticked) await expect(boxes.nth(index)).toBeChecked();
      else await expect(boxes.nth(index)).not.toBeChecked();
    }
  }
  await preview.getByRole("button", { name: "Not imported", exact: true }).click();
  await expect(preview.getByTestId("agent-import-skipped").getByRole("listitem")).toHaveText([
    /IDENTITY\.md: Emoji\s*Not used by Rakazo/,
    /TOOLS\.md\s*Not used by Rakazo/,
  ]);
  // IDENTITY.md names and describes the bot; it is not part of its instructions.
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  await expect(preview.getByRole("textbox", { name: "Description" })).toHaveValue(
    "calm and practical",
  );
  await captureScreenshot(page, testInfo, "agent-import-preview");

  const memorySection = preview.getByTestId("agent-import-memory");
  const memoryTitle = memorySection.getByRole("button", { name: "MEMORY.md", exact: true });
  await expect(memoryTitle).toHaveAttribute("aria-expanded", "false");
  await memoryTitle.click();
  await expect(memoryTitle).toHaveAttribute("aria-expanded", "true");
  await expect(memorySection.getByTestId("agent-import-content")).toHaveText(
    "The garden project starts in spring.",
  );
  await captureScreenshot(page, testInfo, "agent-import-preview-expanded");

  await preview.getByRole("checkbox", { name: "USER.md", exact: true }).click();
  await expect(preview.getByRole("checkbox", { name: "USER.md", exact: true })).not.toBeChecked();
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const pebbleId = activeBotId(page);
  const pebble = await rpc<Bot>(page, "bots/get", { botId: pebbleId });
  expect(pebble.instructions).toBe(
    "# Persona\n\nCalm and direct.\n\n# Working instructions\n\nCheck the calendar before suggesting a time.",
  );
  expect(pebble.description).toBe("calm and practical");
  // An untouched Create imported no skill.
  const pebbleSkills = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(pebbleSkills.some((item) => item.name === "weekly-review")).toBe(false);
  const pebbleMemory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: pebbleId });
  expect(pebbleMemory.map((doc) => [doc.path, doc.content])).toEqual([
    ["MEMORY.md", "The garden project starts in spring.\n"],
  ]);
  const spaceMemory = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(spaceMemory.some((doc) => doc.content.includes("Prefers metric units."))).toBe(false);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const second = await openImport(page);
  await second.getByRole("button", { name: "Copy prompt" }).click();
  await expect(second.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("\n# Skills\n");
  await second.getByRole("textbox", { name: "Paste the reply" }).fill(document);
  await second.getByRole("button", { name: "Continue" }).click();
  const documentPreview = second.getByTestId("agent-import-preview");
  await expect(
    documentPreview.getByTestId("agent-import-memory").getByRole("checkbox"),
  ).toHaveCount(2);
  await expect(documentPreview.getByRole("checkbox", { name: "About me" })).toBeChecked();
  await expect(documentPreview.getByRole("checkbox", { name: "trip-planner" })).not.toBeChecked();
  await documentPreview.getByRole("checkbox", { name: "trip-planner" }).click();
  await expect(documentPreview.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  await clickAndWaitForRpc(
    page,
    documentPreview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await page.waitForURL((url) => !url.pathname.endsWith(pebbleId));
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  const atlasId = activeBotId(page);
  expect((await rpc<Bot>(page, "bots/get", { botId: atlasId })).instructions).toBe("Be concise.");
  const atlasMemory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: atlasId });
  expect(atlasMemory.map((doc) => doc.path).sort()).toEqual(["MEMORY.md", "about-me.md"]);
  const library = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(library.map((item) => item.name)).toEqual(expect.arrayContaining(["trip-planner"]));
});

/** A minimal zip writer (stored entries, with sizes and CRC-32 in both headers). */
function zip(files: Record<string, string>, options: { badCrc?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(content);
    const local = Buffer.alloc(30);
    const crc = options.badCrc ? (crc32(body) ^ 1) >>> 0 : crc32(body);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A minimal ustar writer, gzipped, for synthetic backups built at run time. */
function tarGz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A Hermes `.env` shaped like the real one: many commented lines, then the key. */
const hermesEnv = [
  "# Hermes Agent environment",
  ...Array.from({ length: 40 }, (_, index) => `# EXAMPLE_SETTING_${index}=`),
  "# OPENROUTER_API_KEY=",
  "",
  "TERMINAL_TIMEOUT=60",
  "BROWSER_SESSION_TIMEOUT=300",
  "OPENROUTER_API_KEY=placeholder-openrouter-key",
].join("\n");

test("imports Hermes and OpenClaw backups, reading them on this device", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `agent-import-backup-${stamp}@rakazo.test`, "password12", "Backup User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const hermes = testInfo.outputPath("hermes-backup.zip");
  writeFileSync(
    hermes,
    zip({
      "SOUL.md": "Direct.\n",
      "config.yaml":
        'model:\n  default: "anthropic/claude-sonnet-4.6"\n\n  provider: "openrouter"\n\n  base_url: "https://openrouter.ai/api/v1"\n',
      ".env": hermesEnv,
      "memories/MEMORY.md": "Deploys run on Fridays.\n",
      "skills/.bundled_manifest": "arxiv:abc123\n",
      "skills/research/arxiv/SKILL.md": skill("arxiv", "Papers"),
      "skills/mine/garden-log/SKILL.md": skill("garden-log", "Mine"),
      "state.db": "binary",
    }),
  );
  const panel = await openImport(page);
  const first = page.waitForRequest((request) => request.url().includes("/rpc/bots/importPreview"));
  await panel.getByTestId("agent-import-archive").setInputFiles(hermes);
  const firstBody = (await first).postData() ?? "";
  const firstFiles = (JSON.parse(firstBody) as { json: { files: { path: string }[] } }).json.files;
  // Hermes' own skills, .env and everything else stay on this device.
  expect(firstFiles.map((file) => file.path).sort()).toEqual([
    ".hermes/SOUL.md",
    ".hermes/config.yaml",
    ".hermes/memories/MEMORY.md",
    ".hermes/skills/.bundled_manifest",
    ".hermes/skills/mine/garden-log/SKILL.md",
  ]);
  expect(firstBody).not.toContain("placeholder-");
  const preview = panel.getByTestId("agent-import-preview");
  await expect(
    preview.getByTestId("agent-import-skills").getByRole("checkbox"),
  ).toHaveAccessibleName("garden-log");
  const keys = preview.getByTestId("agent-import-keys");
  const optedRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await keys.getByRole("checkbox", { name: "Include API keys" }).click();
  const optedBody = (await optedRequest).postData() ?? "";
  expect(optedBody).not.toContain("TERMINAL_TIMEOUT");
  expect(optedBody).not.toContain("BROWSER_SESSION_TIMEOUT");
  await expect(keys.getByRole("checkbox", { name: "OpenRouter" })).toBeChecked();
  await captureScreenshot(page, testInfo, "agent-import-backup-hermes");
  await panel.getByRole("button", { name: "Back", exact: true }).click();

  const root = "2026-01-02T03-04-05-openclaw-backup";
  const home = `${root}/payload/posix/home/example/.openclaw`;
  const openclaw = testInfo.outputPath("openclaw-backup.tar.gz");
  writeFileSync(
    openclaw,
    tarGz({
      [`${root}/manifest.json`]: JSON.stringify({
        schemaVersion: 1,
        archiveRoot: root,
        assets: [{ kind: "state", archivePath: home }],
      }),
      [`${home}/openclaw.json`]: '{ gateway: { auth: { token: "placeholder-gateway" } } }',
      [`${home}/credentials/notes.md`]: "EXAMPLE_KEY=placeholder\n",
      [`${home}/workspace/SOUL.md`]: "Backed up.\n",
      [`${home}/workspace/IDENTITY.md`]: "- **Name:** Harbor\n",
    }),
  );
  await panel.getByTestId("agent-import-archive").setInputFiles(openclaw);
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Harbor");
  await expect(preview.getByTestId("agent-import-instructions").getByRole("checkbox")).toHaveCount(
    1,
  );
  await captureScreenshot(page, testInfo, "agent-import-backup-openclaw");

  await panel.getByRole("button", { name: "Back", exact: true }).click();
  const broken = testInfo.outputPath("broken.zip");
  writeFileSync(broken, Buffer.from("PK not really a zip"));
  await panel.getByTestId("agent-import-archive").setInputFiles(broken);
  await expect(panel.getByRole("alert")).toHaveText("This backup could not be read.");
  await captureScreenshot(page, testInfo, "agent-import-backup-error");
  // A zip that opens but whose file fails its checksum when read says so too.
  const corrupt = testInfo.outputPath("corrupt.zip");
  writeFileSync(corrupt, zip({ "SOUL.md": "Direct.\n" }, { badCrc: true }));
  await panel.getByTestId("agent-import-archive").setInputFiles(corrupt);
  await expect(panel.getByRole("alert")).toHaveText("This backup could not be read.");
});

test("an imported bot asks before using MCP servers, and its import can be undone", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `agent-import-undo-${stamp}@rakazo.test`, "password12", "Undo User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const home = testInfo.outputPath("openclaw-home");
  writeFolder(home, {
    "openclaw.json":
      '{ mcp: { servers: { docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer placeholder-token" } } } } }',
    "cron/jobs.json": JSON.stringify({
      jobs: [
        {
          name: "morning",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "agentTurn", message: "Summarise my day" },
        },
      ],
    }),
    "workspace/SOUL.md": "Careful.\n",
    "workspace/IDENTITY.md": "- **Name:** Undoable\n",
    "skills/inbox-triage/SKILL.md": skill("inbox-triage", "Sort the inbox"),
  });
  const panel = await openImport(page);
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(
    preview.getByTestId("agent-import-routines").getByText("Paused", { exact: true }),
  ).toBeVisible();
  for (const name of ["docs", "inbox-triage", "morning"]) {
    const box = preview.getByRole("checkbox", { name });
    await expect(box).not.toBeChecked();
    await box.click();
  }
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Undoable")).toBeVisible();
  const botId = activeBotId(page);

  // The server is not given to the bot until the user approves it here.
  const card = page.getByTestId("mcp-approval-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-approval-card");

  // One checklist of what is left: the server's credentials and turning the routine on.
  const setup = page.getByTestId("import-setup-card");
  await expect(setup.getByRole("listitem")).toHaveText([
    "docsCredentials: AuthorizationOpen",
    "morningPausedOpen",
  ]);
  await captureScreenshot(page, testInfo, "agent-import-setup-checklist");
  // Open goes straight to the imported server's form; saving keeps the same server.
  await setup.getByRole("button", { name: "Open docs" }).click();
  const mcpDialog = page.getByRole("dialog");
  await expect(mcpDialog.getByText("MCP servers", { exact: true })).toBeVisible();
  await expect(mcpDialog.getByLabel("Server name")).toHaveValue("docs");
  await mcpDialog.getByText("Advanced", { exact: true }).click();
  await expect(mcpDialog.getByLabel("Header name", { exact: true })).toHaveValue("Authorization");
  await mcpDialog.getByLabel("Header value", { exact: true }).fill("Bearer placeholder-new-token");
  await captureScreenshot(page, testInfo, "agent-import-mcp-edit");
  await clickAndWaitForRpc(
    page,
    mcpDialog.getByRole("button", { name: "Save", exact: true }),
    "mcp/servers/update",
  );
  const servers = await rpc<{ id: string; name: string }[]>(page, "mcp/servers/list", {});
  expect(servers.filter((server) => server.name === "docs")).toHaveLength(1);
  await page.getByRole("button", { name: "Close MCP servers" }).click();

  await page.getByTestId("bot-settings-trigger").click();
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await page.getByTestId("agent-import-undo").click();
  const dialog = page.getByTestId("agent-import-undo-dialog");
  await expect(dialog.getByRole("region", { name: "Removed" }).getByRole("listitem")).toHaveText([
    "inbox-triage",
  ]);
  // Its credentials were entered since, so the server stays.
  await expect(
    dialog.getByRole("region", { name: "Kept" }).getByText("docs", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-undo");
  await clickAndWaitForRpc(
    page,
    dialog.getByRole("button", { name: "Undo import", exact: true }),
    "bots/importUndo",
  );
  await expect(dialog).toHaveCount(0);
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.some((bot) => bot.id === botId)).toBe(false);
  const skills = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(skills.some((item) => item.name === "inbox-triage")).toBe(false);
});

test("Undo removes only the import it showed, even after another tab undid it", async ({
  page,
}, testInfo) => {
  await signup(page, `agent-import-undo-shown-${Date.now()}@rakazo.test`, "password12", "Shown");
  await completeOnboarding(page);
  // A bot an import made, then a second import added to it.
  const files = [
    { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
    { path: ".openclaw/workspace/IDENTITY.md", content: "- **Name:** Pebble\n" },
    { path: ".openclaw/workspace/MEMORY.md", content: "Project Alpha.\n" },
  ];
  const plan = await rpc<AgentImportPlan>(page, "bots/importPreview", { files });
  const memory = plan.memory.map((item) => ({ id: item.id, destination: "bot" }));
  const bot = await rpc<Bot>(page, "bots/importCreate", {
    files,
    name: "Pebble",
    selection: { instructions: plan.instructions.map((item) => item.id), memory, skills: [] },
  });
  await rpc(page, "bots/importCreate", {
    files,
    destination: { kind: "existing", botId: bot.id },
    selection: { instructions: [], memory, skills: [] },
  });
  await page.goto(`/app/${bot.id}`);
  await page.getByTestId("bot-settings-trigger").click();
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await page.getByTestId("agent-import-undo").click();
  const dialog = page.getByTestId("agent-import-undo-dialog");
  await expect(dialog).toContainText("What the import added will be removed. The bot stays.");

  // Another tab undoes that addition before this one confirms.
  const shown = await rpc<AgentImportInfo>(page, "bots/importInfo", { botId: bot.id });
  await rpc(page, "bots/importUndo", { botId: bot.id, importId: shown.id });
  await dialog.getByRole("button", { name: "Undo import", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This import changed. Try again.");
  // Nothing was removed, and the dialog now says what Undo would do instead.
  await expect(dialog).toContainText("The bot and what its import added will be removed.");
  await captureScreenshot(page, testInfo, "agent-import-undo-changed");
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.some((item) => item.id === bot.id)).toBe(true);
});

/** OpenClaw's SOUL.md as it seeds it (template without front matter), and Hermes' SOUL.md. */
const OPENCLAW_DEFAULT_SOUL =
  "# SOUL.md - Who You Are\n\n_You're not a chatbot. You're becoming someone._\n\nWant a sharper version? See [SOUL.md personality guide](/concepts/soul).\n\n## Core Truths\n\n**Be genuinely helpful, not performatively helpful.** Skip the \"Great question!\" and \"I'd be happy to help!\" — just help.\n\n**Have opinions.** Disagree, prefer things, find stuff amusing or boring. No personality is just a search engine with extra steps.\n\n**Be resourceful before asking.** Read the file, check the context, search for it. Come back with answers, not questions.\n\n**Earn trust through competence.** Do what you're asked, fully. Check before public or outbound actions nobody asked for.\n\n**Remember you're a guest.** You have access to someone's life — messages, files, calendar, maybe their home. Treat it with respect.\n\n## Boundaries\n\n- Don't leak private things into shared or public spaces.\n- Never send half-baked replies to messaging surfaces.\n- Speak as yourself in group chats unless the user asks you to send or post on their behalf.\n\n## Vibe\n\nConcise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.\n\n## Continuity\n\nEach session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.\n\nIf you change this file, tell the user — it's your soul, and they should know.\n\n---\n\n_This file is yours to evolve. As you learn who you are, update it._\n\nSave this file at the workspace root as `SOUL.md`.\n\n## Related\n\n- [SOUL.md personality guide](/concepts/soul)\n";
const HERMES_DEFAULT_SOUL =
  "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler (\"Great question,\" \"I'd be happy to\"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or the stakes demand it, not by default.";

test("untouched defaults start unticked, and OpenClaw runtime references are flagged", async ({
  page,
}, testInfo) => {
  await signup(page, `agent-import-defaults-${Date.now()}@rakazo.test`, "password12", "Defaults");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const home = testInfo.outputPath("openclaw-defaults");
  writeFolder(home, {
    "workspace/SOUL.md": OPENCLAW_DEFAULT_SOUL,
    "workspace/AGENTS.md":
      "# House rules\n\nAnswer briefly.\n\n## Session Startup\n\nRead BOOTSTRAP.md first.\n",
  });
  const panel = await openImport(page);
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const instructions = panel.getByTestId("agent-import-instructions");
  await expect(instructions.getByRole("checkbox", { name: "SOUL.md" })).not.toBeChecked();
  await expect(
    instructions.getByText("Persona, Default from OpenClaw", { exact: true }),
  ).toBeVisible();
  await expect(instructions.getByRole("checkbox", { name: "AGENTS.md" })).toBeChecked();
  await expect(
    instructions.getByText("Working instructions, Mentions OpenClaw features", { exact: true }),
  ).toBeVisible();
  await instructions.getByRole("button", { name: "AGENTS.md", exact: true }).click();
  await expect(instructions.getByText("Mentions: Session Startup, BOOTSTRAP.md")).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-defaults-openclaw");
  await panel.getByRole("button", { name: "Back", exact: true }).click();

  const hermes = testInfo.outputPath("hermes-defaults.zip");
  writeFileSync(
    hermes,
    zip({
      "SOUL.md": HERMES_DEFAULT_SOUL,
      "AGENTS.md": "Answer in English.\n",
      "config.yaml": "model:\n  provider: openrouter\n",
    }),
  );
  await panel.getByTestId("agent-import-archive").setInputFiles(hermes);
  await expect(instructions.getByRole("checkbox", { name: "SOUL.md" })).not.toBeChecked();
  await expect(
    instructions.getByText("Persona, Default from Hermes", { exact: true }),
  ).toBeVisible();
  await expect(instructions.getByRole("checkbox", { name: "AGENTS.md" })).toBeChecked();
  await captureScreenshot(page, testInfo, "agent-import-defaults-hermes");
});

test("imports into an existing bot only when chosen, keeping its instructions unless replaced", async ({
  page,
}, testInfo) => {
  await signup(page, `agent-import-existing-${Date.now()}@rakazo.test`, "password12", "Existing");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  await rpc(page, "bots/update", { botId: chief!.id, instructions: "Chief's own instructions." });

  const home = testInfo.outputPath("openclaw-existing");
  writeFolder(home, {
    "workspace/SOUL.md": "Calm and direct.\n",
    "workspace/AGENTS.md": "Short replies.\n",
    "workspace/MEMORY.md": "Project Alpha.\n",
    "workspace/IDENTITY.md": "- **Name:** Pebble\n",
  });
  const panel = await openImport(page);
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  const destination = preview.getByTestId("agent-import-destination");
  // A new bot is the default; an existing bot is never preselected.
  await expect(destination.getByRole("button", { name: "New bot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "agent-import-destination-new");
  await destination.getByRole("button", { name: "Add to an existing bot" }).click();
  const picker = destination.getByRole("combobox", { name: "Bot" });
  await expect(picker).toHaveValue("");
  await expect(preview.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await picker.selectOption({ label: "Chief" });
  const choice = destination.getByTestId("agent-import-instructions-choice");
  await expect(choice.getByRole("button", { name: "Keep its instructions" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(preview.getByTestId("agent-import-instructions")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "agent-import-destination-existing");
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Add", exact: true }),
    "bots/importCreate",
  );
  // Done visibly: the panel closes on that bot's chat, as for a new bot.
  await page.waitForURL(new RegExp(`/app/${chief!.id}$`));
  await expect(page.getByTestId("agent-import")).toHaveCount(0);
  const kept = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  expect([kept.name, kept.instructions]).toEqual(["Chief", "Chief's own instructions."]);
  const memory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: chief!.id });
  expect(memory.map((doc) => doc.path).sort()).toEqual(["MEMORY-2.md", "MEMORY.md"]);

  // Replacing is its own explicit choice, recorded so it can be restored.
  const again = await openImport(page);
  await again.getByTestId("agent-import-folder").setInputFiles(home);
  const second = again.getByTestId("agent-import-preview");
  await second
    .getByTestId("agent-import-destination")
    .getByRole("button", { name: "Add to an existing bot" })
    .click();
  await second.getByRole("combobox", { name: "Bot" }).selectOption({ label: "Chief" });
  await second.getByRole("button", { name: "Replace its instructions" }).click();
  await expect(second.getByTestId("agent-import-instructions")).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-destination-replace");
  await clickAndWaitForRpc(
    page,
    second.getByRole("button", { name: "Add", exact: true }),
    "bots/importCreate",
  );
  await expect
    .poll(async () => (await rpc<Bot>(page, "bots/get", { botId: chief!.id })).instructions)
    .toBe("# Persona\n\nCalm and direct.\n\n# Working instructions\n\nShort replies.");

  await page.getByTestId("bot-settings-trigger").click();
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await page.getByTestId("agent-import-undo").click();
  const dialog = page.getByTestId("agent-import-undo-dialog");
  await expect(dialog).toContainText("What the import added will be removed. The bot stays.");
  await expect(dialog.getByTestId("agent-import-undo-instructions")).toHaveText(
    "Its instructions go back to before the import.",
  );
  await captureScreenshot(page, testInfo, "agent-import-undo-existing");
  await clickAndWaitForRpc(
    page,
    dialog.getByRole("button", { name: "Undo import", exact: true }),
    "bots/importUndo",
  );
  await expect(dialog).toHaveCount(0);
  const restored = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  expect(restored.instructions).toBe("Chief's own instructions.");
});

/** Drops a synthetic folder (as file system entries) or files onto the chat composer. */
async function dropOnComposer(
  page: Page,
  drop: {
    folder?: { name: string; files: Record<string, string> };
    zip?: { name: string; base64: string };
  },
) {
  await page.evaluate(({ folder, zip }) => {
    const target = window.document.querySelector("fieldset[aria-label='Message composer']");
    if (!target) throw new Error("composer not found");
    type Tree = { [name: string]: string | Tree };
    const tree: Tree = {};
    for (const [path, content] of Object.entries(folder?.files ?? {})) {
      const parts = path.split("/");
      let node = tree;
      for (const part of parts.slice(0, -1)) {
        node[part] ??= {};
        node = node[part] as Tree;
      }
      node[parts.at(-1)!] = content;
    }
    const entry = (name: string, value: string | Tree, parent: string): unknown => {
      const fullPath = `${parent}/${name}`;
      if (typeof value === "string") {
        return {
          name,
          fullPath,
          isFile: true,
          isDirectory: false,
          file: (resolve: (file: File) => void) => resolve(new File([value], name)),
        };
      }
      let listed = false;
      const children = Object.entries(value).map(([child, inner]) => entry(child, inner, fullPath));
      return {
        name,
        fullPath,
        isFile: false,
        isDirectory: true,
        createReader: () => ({
          readEntries: (resolve: (entries: unknown[]) => void) => {
            resolve(listed ? [] : children);
            listed = true;
          },
        }),
      };
    };
    const files = zip
      ? [new File([Uint8Array.from(atob(zip.base64), (c) => c.charCodeAt(0))], zip.name)]
      : [new File([], folder!.name)];
    const root = folder ? entry(folder.name, tree, "") : null;
    const dataTransfer = {
      files,
      types: ["Files"],
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
        webkitGetAsEntry: () =>
          root ?? { name: file.name, fullPath: `/${file.name}`, isFile: true, isDirectory: false },
      })),
      dropEffect: "copy",
    };
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(event);
    }
  }, drop);
}

test("an agent dropped into a chat is offered for import, never uploaded first", async ({
  page,
}, testInfo) => {
  await signup(page, `agent-import-drop-${Date.now()}@rakazo.test`, "password12", "Dropper");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/rpc/artifacts/") || url.includes("/rpc/bots/import")) requests.push(url);
  });

  await dropOnComposer(page, {
    folder: {
      name: "openclaw-home",
      files: {
        "openclaw.json": "{}",
        ".env": "OPENROUTER_API_KEY=placeholder-drop-key\n",
        "workspace/SOUL.md": "Calm and direct.\n",
        "workspace/IDENTITY.md": "- **Name:** Pebble\n",
      },
    },
  });
  const choice = page.getByTestId("agent-drop-choice");
  await expect(choice).toContainText("Import this agent as a bot?");
  // Nothing has left the browser: no attachment upload and no import request yet.
  expect(requests).toEqual([]);
  await captureScreenshot(page, testInfo, "agent-import-drop-choice");

  const preview = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await choice.getByRole("button", { name: "Import", exact: true }).click();
  expect((await preview).postData() ?? "").not.toContain("placeholder-");
  const panel = page.getByTestId("agent-import-preview");
  await expect(panel.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  const destination = panel.getByTestId("agent-import-destination");
  // A new bot is the default; the chat's bot is offered but not chosen.
  await expect(destination.getByRole("button", { name: "New bot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await destination.getByRole("button", { name: "Add to an existing bot" }).click();
  const picker = destination.getByRole("combobox", { name: "Bot" });
  await expect(picker).toHaveValue("");
  await expect(picker.getByRole("option", { name: chief!.name })).toHaveCount(1);
  await destination.getByRole("button", { name: "New bot" }).click();
  await captureScreenshot(page, testInfo, "agent-import-drop-preview");
  // Back leaves the preview, then closes the panel: a drop never came from the New bot dialog.
  const importPanel = page.getByTestId("agent-import");
  await importPanel.getByRole("button", { name: "Back", exact: true }).click();
  await importPanel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importPanel).toHaveCount(0);
  await expect(page.getByTestId("create-bot-dialog")).toHaveCount(0);

  // A backup can still be attached as a file, as before.
  const backup = Buffer.from(
    zip({ "SOUL.md": "Direct.\n", "config.yaml": "model:\n  provider: openrouter\n" }),
  ).toString("base64");
  requests.length = 0;
  await dropOnComposer(page, { zip: { name: "hermes.zip", base64: backup } });
  await expect(choice).toBeVisible();
  expect(requests).toEqual([]);
  await choice.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove hermes.zip" })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-drop-attached");

  // An ordinary archive is attached straight away, with no question.
  await dropOnComposer(page, {
    zip: { name: "photos.zip", base64: Buffer.from(zip({ "photo.txt": "x" })).toString("base64") },
  });
  await expect(page.getByRole("button", { name: "Remove photos.zip" })).toBeVisible();
  await expect(choice).toHaveCount(0);
});

test("an item with key-looking text starts unticked and says so", async ({ page }, testInfo) => {
  await signup(page, `agent-import-key-${Date.now()}@rakazo.test`, "password12", "Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // Synthetic, built from parts so no scanner mistakes it for a leak.
  const key = ["sk", "-proj-", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA12345678"].join("");
  const panel = await openImport(page);
  await panel
    .getByRole("textbox", { name: "Paste the reply" })
    .fill(`# Instructions\nBe brief.\n\n# Memory\n## Deploy\nThe deploy key is ${key}.\n`);
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  const memory = panel.getByTestId("agent-import-memory");
  await expect(memory).toContainText("Looks like it contains a key");
  await expect(memory.getByRole("checkbox").first()).not.toBeChecked();
  // The label never repeats the key; the user's own text is there when expanded.
  await expect(memory.getByRole("checkbox").first()).not.toHaveAccessibleName(new RegExp(key));
  await captureScreenshot(page, testInfo, "agent-import-contains-key");
});
