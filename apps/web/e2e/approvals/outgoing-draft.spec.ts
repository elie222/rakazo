import { expect, test } from "@playwright/test";

test("an outgoing email can be reviewed and edited before sending", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=approvals&theme=dark");
  const draft = page.getByTestId("outgoing-draft-card");
  await expect(draft.getByRole("textbox", { name: "To" })).toHaveValue("sam@example.test");
  await expect(draft.getByRole("textbox", { name: "Subject" })).toHaveValue("Friday handoff");
  await expect(draft.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await draft.scrollIntoViewIfNeeded();
  const screenshot = testInfo.outputPath("outgoing-email-draft.png");
  await draft.screenshot({ path: screenshot, animations: "disabled", caret: "hide" });
  await testInfo.attach("outgoing-email-draft", { contentType: "image/png", path: screenshot });

  await draft.getByRole("textbox", { name: "To" }).fill("invalid");
  await expect(draft.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await draft.getByRole("textbox", { name: "To" }).fill("taylor@example.test");
  await draft.getByRole("textbox", { name: "Subject" }).fill("");
  await draft.getByRole("textbox", { name: "Message" }).fill("");
  await expect(draft.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await draft.getByRole("textbox", { name: "Message" }).fill("Could you review this on Thursday?");
  await expect(draft.getByRole("textbox", { name: "To" })).toHaveValue("taylor@example.test");
  await expect(draft.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Could you review this on Thursday?",
  );
  await expect(draft.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});
