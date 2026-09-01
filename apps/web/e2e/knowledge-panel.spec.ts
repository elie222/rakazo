import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

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
  await expect(knowledge.getByText("Knowledge", { exact: true })).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`); edit it and assert the revision bumps.
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills: create one through the editor, reopen it, edit, then delete it.
  // Builtin catalog is currently empty; user skills still cover create/edit/delete.
  await knowledge.getByRole("button", { name: "Skills", exact: true }).click();
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

  // Space-wide documents live in the Memory settings overlay and are editable.
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Shared documents")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
});
