import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("skills marketplace installs, scopes, imports, and edits recipes", async ({
  page,
}, testInfo) => {
  expect((await page.request.get("/api/skills/fetch-url?url=https://127.0.0.1/")).status()).toBe(
    401,
  );
  expect((await page.request.get("/api/skills/skillsmp-search?q=agent")).status()).toBe(401);
  await signup(page, `skills-marketplace-${Date.now()}@rakazo.test`, "password12", "Skills Demo");
  await completeOnboarding(page, testInfo);
  for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://[fd12::1]/"]) {
    const response = await page.request.get(`/api/skills/fetch-url?url=${encodeURIComponent(url)}`);
    expect(response.ok()).toBe(false);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/private|internal/i),
    });
  }
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByText("Integrations", { exact: true }).click();
  await page.getByRole("tab", { name: /Agent Skills/ }).click();
  await expect(
    page.getByPlaceholder("Filter installed skills by name or keyword..."),
  ).toBeVisible();
  const installedTab = page.getByRole("tab", { name: /Installed Skills/ });
  await installedTab.focus();
  await installedTab.press("End");
  const importTab = page.getByRole("tab", { name: "Import from URL / MD", exact: true });
  await expect(importTab).toBeFocused();
  await importTab.press("Enter");
  await expect(importTab).toHaveAttribute("aria-selected", "true");
  await importTab.press("Home");
  await installedTab.press("Enter");
  await expect(installedTab).toHaveAttribute("aria-selected", "true");
  await captureScreenshot(page, testInfo, "skills-installed");

  await page.getByRole("tab", { name: "Marketplace Hub", exact: true }).click();
  await expect(page.getByText("Lean output", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "skills-marketplace-curated");
  await page.getByRole("button", { name: "Preview Recipe", exact: true }).first().click();
  let dialog = page.getByRole("dialog").last();
  await expect(dialog.getByRole("textbox")).toContainText("# Lean output");
  await captureScreenshot(page, testInfo, "skills-recipe-preview");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: "Install Skill", exact: true }).first().click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByRole("radio", { name: "Selected Bots Only" }).check();
  await dialog.getByRole("checkbox", { name: /^Chief\b/ }).uncheck();
  await expect(dialog.getByRole("button", { name: "Confirm Install" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /^Chief\b/ }).check();
  await captureScreenshot(page, testInfo, "skills-install-bot-assignment");
  await dialog.getByRole("button", { name: "Confirm Install" }).click();
  await expect(
    page.getByRole("dialog", { name: "Install Skill: Lean output", exact: true }),
  ).toBeHidden();
  await page.getByRole("tab", { name: /Installed Skills/ }).click();
  await page.getByPlaceholder("Filter installed skills by name or keyword...").fill("Lean output");
  await page.getByRole("button", { name: "Bot Scope", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await expect(dialog.getByRole("checkbox", { name: /^Chief\b/ })).toBeChecked();
  await captureScreenshot(page, testInfo, "skills-scope-editor");
  await dialog.getByRole("radio", { name: "Global (All Bots)" }).check();
  await dialog.getByRole("button", { name: "Save Scope" }).click();
  await expect(
    page.getByRole("dialog", { name: "Configure Bot Scope: Lean output", exact: true }),
  ).toBeHidden();
  const skills = await rpc<Array<{ name: string; content: string }>>(page, "agentSkills/list", {});
  expect(skills.find((skill) => skill.name === "Lean output")?.content).toContain("scope: global");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await captureScreenshot(page, testInfo, "skills-recipe-editor");
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "New Custom Skill", exact: true }).click();
  await captureScreenshot(page, testInfo, "skills-new-custom");
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await page.route("**/api/skills/skillsmp-search?*", (route) =>
    route.fulfill({
      json: { success: true, data: { skills: [] } },
    }),
  );
  await page.getByRole("tab", { name: "Marketplace Hub", exact: true }).click();
  await page.getByRole("tab", { name: /SkillsMP Directory/ }).click();
  await expect(page.getByText(/No skills found on SkillsMP/)).toBeVisible();
  await captureScreenshot(page, testInfo, "skills-marketplace-directory");
  await page.getByRole("tab", { name: "Import from URL / MD", exact: true }).click();
  await page
    .getByPlaceholder(/^---\nname: my-skill/)
    .fill(
      "---\nname: Weekly review\ndescription: Review weekly progress\n---\nSummarize progress and blockers.",
    );
  await captureScreenshot(page, testInfo, "skills-import-markdown");
  await page.getByRole("button", { name: "Import & Install Skill", exact: true }).click();
  await expect
    .poll(async () =>
      (await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).some(
        (skill) => skill.name === "Weekly review",
      ),
    )
    .toBe(true);
});
