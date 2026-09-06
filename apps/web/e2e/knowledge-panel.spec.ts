import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { MemoryDocument } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Space-wide documents live in the Memory settings overlay. Open that before
  // bot settings so the Knowledge Memory tab cannot steal this click.
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Shared documents")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/rpc/memory/update",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(docEditor).toBeDisabled();
    await expect(memoryRow).toBeDisabled();
    await expect(spaceDocs.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  const sharedDocuments = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(sharedDocuments).toContainEqual(
    expect.objectContaining({ content: `# Memory\n\n${marker}\n`, revision: 2 }),
  );
  // Export must fetch fresh content and exclude the bot's private document.
  const sharedDocument = sharedDocuments.find((doc) => doc.path === "MEMORY.md")!;
  const latestMarker = `Latest shared memory ${stamp}`;
  await rpc(page, "memory/update", { documentId: sharedDocument.id, content: latestMarker });
  const downloadPromise = page.waitForEvent("download");
  await spaceDocs.getByRole("button", { name: "Download as markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("space-memory.md");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain(latestMarker);
  expect(exported).not.toContain(marker);
  expect(exported).not.toContain("# Chief");
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  // The bot's Knowledge section lives under Advanced in its settings panel.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByRole("tablist", { name: "Knowledge" })).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`); edit it and assert the revision bumps.
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await botMemory.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", {
      botId: activeBotId(page),
      scope: "bot",
    }),
  ).toContainEqual(expect.objectContaining({ content: `# Chief\n\n${botMarker}\n`, revision: 2 }));
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills: create one through the editor, reopen it, edit, then delete it.
  // Builtin catalog is currently empty; user skills still cover create/edit/delete.
  await knowledge.getByRole("tab", { name: "Skills", exact: true }).click();
  await knowledge.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = knowledge.locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = knowledge.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(knowledge.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(
    page.getByRole("button", { name: "Skill greet-politely", exact: true }),
  ).toBeVisible();
  await composer.fill("");

  // A provider-owned skill uses the same viewer without mutation controls.
  await page.route(
    "**/rpc/agentSkills/get",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, json: { ...body.json, readOnly: true, source: "plugin" } },
      });
    },
    { times: 1 },
  );
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(knowledge.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(knowledge.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await knowledge.getByRole("button", { name: "Close", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  await knowledge.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledge.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();
  await composer.fill("/");
  await expect(page.getByRole("button", { name: "Skill greet-politely", exact: true })).toHaveCount(
    0,
  );
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );
});
