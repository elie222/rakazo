import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, MemoryDocument } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
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
  "IDENTITY.md": "- **Name:** Pebble\n",
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
  await page.getByTestId("create-bot-form").getByTestId("create-bot-import").click();
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
  // Items that may not work here start unticked, with the reason next to them.
  const skills = homePreview.getByTestId("agent-import-skills");
  await expect(skills.getByRole("checkbox", { name: "cleanup" })).not.toBeChecked();
  await expect(skills.getByText("Contains code to run", { exact: true })).toBeVisible();
  const mcp = homePreview.getByTestId("agent-import-mcp");
  await expect(mcp.getByRole("checkbox", { name: "docs" })).toBeChecked();
  await expect(mcp.getByRole("checkbox", { name: "files" })).toBeDisabled();
  await expect(mcp.getByText("Not supported in Rakazo", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-compatibility");
  // Choices made before the opt-in survive it, in both directions.
  const nameBox = homePreview.getByRole("textbox", { name: "Name" });
  await nameBox.fill("Home bot");
  await skills.getByRole("checkbox", { name: "inbox-triage" }).click();
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
  await expect(model.getByText("Needs this provider's API key", { exact: true })).toBeVisible();
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
    'DEEPSEEK_API_KEY="placeholder-deepseek-key"\n',
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
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).not.toBeChecked();
  await optIn.click();
  await expect(optIn).not.toBeChecked();
  await expect(keys.getByRole("heading", { name: "API keys" })).toHaveCount(0);
  await expect(nameBox).toHaveValue("Home bot");
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).not.toBeChecked();
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
  for (const [section, names] of [
    ["agent-import-instructions", ["SOUL.md", "AGENTS.md", "IDENTITY.md"]],
    ["agent-import-memory", ["MEMORY.md", "USER.md"]],
    ["agent-import-skills", ["weekly-review"]],
  ] as const) {
    const boxes = preview.getByTestId(section).getByRole("checkbox");
    await expect(boxes).toHaveCount(names.length);
    for (const [index, name] of names.entries()) {
      await expect(boxes.nth(index)).toHaveAccessibleName(name);
      await expect(boxes.nth(index)).toBeChecked();
    }
  }
  await preview.getByRole("button", { name: "Not imported", exact: true }).click();
  await expect(preview.getByTestId("agent-import-skipped").getByRole("listitem")).toHaveText([
    "TOOLS.md · Not used by Rakazo",
  ]);
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
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
  await preview.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const pebbleId = activeBotId(page);
  const pebble = await rpc<Bot>(page, "bots/get", { botId: pebbleId });
  expect(pebble.instructions).toContain("Calm and direct.");
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
  await expect(documentPreview.getByRole("checkbox", { name: "trip-planner" })).toBeChecked();
  await expect(documentPreview.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  await documentPreview.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith(pebbleId));
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  const atlasId = activeBotId(page);
  expect((await rpc<Bot>(page, "bots/get", { botId: atlasId })).instructions).toBe("Be concise.");
  const atlasMemory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: atlasId });
  expect(atlasMemory.map((doc) => doc.path).sort()).toEqual(["MEMORY.md", "about-me.md"]);
  const library = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(library.map((item) => item.name)).toEqual(
    expect.arrayContaining(["weekly-review", "trip-planner"]),
  );
});

/** A minimal zip writer (stored entries), for synthetic backups built at run time. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
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
    2,
  );
  await captureScreenshot(page, testInfo, "agent-import-backup-openclaw");

  await panel.getByRole("button", { name: "Back", exact: true }).click();
  const broken = testInfo.outputPath("broken.zip");
  writeFileSync(broken, Buffer.from("PK not really a zip"));
  await panel.getByTestId("agent-import-archive").setInputFiles(broken);
  await expect(panel.getByRole("alert")).toHaveText("This backup could not be read.");
  await captureScreenshot(page, testInfo, "agent-import-backup-error");
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
    "openclaw.json": '{ mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } } }',
    "workspace/SOUL.md": "Careful.\n",
    "workspace/IDENTITY.md": "- **Name:** Undoable\n",
    "skills/inbox-triage/SKILL.md": skill("inbox-triage", "Sort the inbox"),
  });
  const panel = await openImport(page);
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview.getByRole("checkbox", { name: "docs" })).toBeChecked();
  await preview.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Undoable")).toBeVisible();
  const botId = activeBotId(page);

  // The server is not given to the bot until the user approves it here.
  const card = page.getByTestId("mcp-approval-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-approval-card");

  await page.getByTestId("bot-settings-trigger").click();
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await page.getByTestId("agent-import-undo").click();
  const dialog = page.getByTestId("agent-import-undo-dialog");
  await expect(dialog.getByRole("region", { name: "Removed" }).getByRole("listitem")).toHaveText([
    "inbox-triage",
    "docs",
  ]);
  await captureScreenshot(page, testInfo, "agent-import-undo");
  await dialog.getByRole("button", { name: "Undo import", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.some((bot) => bot.id === botId)).toBe(false);
  const skills = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(skills.some((item) => item.name === "inbox-triage")).toBe(false);
});
