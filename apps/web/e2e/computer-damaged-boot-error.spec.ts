import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const damaged = "This computer's system is damaged. Recover the computer to rebuild it.";

test("a damaged computer tells the user to recover it when the boot fails", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `computer-damaged-${Date.now()}@rakazo.test`,
    "password12",
    "Computer Damaged",
  );
  await completeOnboarding(page);
  await page.route("**/rpc/computer/boot", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        json: { defined: false, code: "CONFLICT", status: 409, message: damaged },
      }),
    }),
  );

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  const preview = page.getByTestId("computer-preview");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("alert").getByText(damaged, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-damaged-boot-error");
});
