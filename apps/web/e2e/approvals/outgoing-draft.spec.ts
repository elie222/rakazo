import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

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

test("a batched app action groups destinations above the file content", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=batched-app-action&theme=light");
  const detail = page.getByTestId("ask-detail");
  const card = detail.locator("..");

  await expect(
    card.getByText("Allow Googledrive create file, Gmail send email?", { exact: true }),
  ).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(detail).toHaveText(
    /^Googledrive create file\nFile name: Workshop notes\.txt\n\nGmail send email\nTo email: sam@example\.com\n\nGoogledrive create file\nText content: The workshop starts at ten on Friday\..*share the next steps\.$/,
  );
  await expect(card).not.toContainText("GOOGLEDRIVE_GOOGLE_DRIVE_CREATE_FILE");
  await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();

  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(detail).toHaveJSProperty(
    "scrollHeight",
    await detail.evaluate((node) => node.clientHeight),
  );
  await captureScreenshot(page, testInfo, "01-batched-app-action-approval-card");
});
