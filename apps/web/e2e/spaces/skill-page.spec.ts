import { expect, test } from "@playwright/test";
import type { AgentSkill } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

test("a personal skill and its file editors are visible", async ({ page }, testInfo) => {
  const name = "greet-politely";
  const description = "Say hello before anything else.";
  const instructions = "Always open with a greeting.";
  await signup(page, `skill-page-${Date.now()}@rakazo.test`, "password12", "Skill Owner");
  await completeOnboarding(page);
  const { id: skillId } = await rpc<AgentSkill>(page, "agentSkills/create", {
    content: ["---", `name: ${name}`, `description: ${description}`, "---", "", instructions].join(
      "\n",
    ),
  });
  await rpc(page, "agentSkills/update", {
    skillId,
    file: { path: "references/tone.md", content: "# Tone\n\nKeep it warm and brief." },
  });

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills", exact: true });
  const skills = dialog.getByTestId("your-skills");
  await skills.getByRole("button", { name: /greet-politely/ }).click();

  const skill = skills.getByTestId("skill-page");
  const files = skill.getByRole("navigation", { name: "Files", exact: true });
  const document = files.getByRole("button", { name: "SKILL.md", exact: true });
  const toneFile = files.getByRole("button", { name: /^tone\.md/ });
  const readInstructions = skill.getByText(instructions, { exact: true });

  await expect(readInstructions).toBeVisible();
  await expect(document).toHaveAttribute("aria-current", "true");
  await expect(toneFile).toBeVisible();
  await captureScreenshot(page, testInfo, "skill-page-read");

  await toneFile.click();
  await expect(toneFile).toHaveAttribute("aria-current", "true");
  await expect(skill.getByText("Keep it warm and brief.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "skill-file-open");

  await document.click();
  await skill.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(skill.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(skill.getByLabel("Description", { exact: true })).toHaveValue(description);
  await expect(skill.getByLabel("Instructions", { exact: true })).toHaveValue(instructions);
  await captureScreenshot(page, testInfo, "skill-edit-form");
  const cancel = skill.getByRole("button", { name: "Cancel", exact: true });
  await cancel.click();

  await files.getByRole("button", { name: "Add file", exact: true }).click();
  const path = files.getByLabel("New file path", { exact: true });
  const body = skill.getByLabel("File text", { exact: true });
  const draftPath = "references/examples.md";
  const draftBody = "# Examples\n\nHello, thanks for reaching out.";
  await path.fill(draftPath);
  await body.fill(draftBody);
  await expect(path).toHaveValue(draftPath);
  await expect(body).toHaveValue(draftBody);
  await captureScreenshot(page, testInfo, "skill-new-file");
  await cancel.click();

  const desktopViewport = page.viewportSize();
  if (!desktopViewport) throw new Error("The skill screenshot requires a configured viewport");
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await expect(document).toHaveAttribute("aria-current", "true");
    await expect(toneFile).toBeVisible();
    await expect(readInstructions).toBeVisible();
    await captureScreenshot(page, testInfo, "skill-page-phone");
  } finally {
    await page.setViewportSize(desktopViewport);
  }
});
