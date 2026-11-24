import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  rpc,
  signup,
} from "../helpers/helpers";

async function inSpace<T>(page: Page, spaceId: string, path: string, json: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${path}`, {
    headers: { "x-rakazo-space-id": spaceId },
    data: { json },
  });
  const body = (await response.json()) as { json: T };
  expect(response.ok(), `${path} ${response.status()}`).toBe(true);
  return body.json;
}

test("another member's routine is read-only, can be turned on, and can be copied", async ({
  browser,
}, testInfo) => {
  const stamp = Date.now();
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  await signup(owner, `routine-owner-${stamp}@rakazo.test`, "password12", "Dana Owner");
  await completeOnboarding(owner);
  await signup(member, `routine-member-${stamp}@rakazo.test`, "password12", "Ada Member");
  await completeOnboarding(member);

  const home = await rpc<{ id: string }>(owner, "spaces/create", { name: "Home" });
  const invite = await rpc<{ url: string }>(owner, "spaces/invites/create", { spaceId: home.id });
  await rpc(member, "spaces/invites/accept", {
    token: new URL(invite.url).pathname.split("/").pop(),
  });
  const bot = await inSpace<{ id: string }>(owner, home.id, "bots/create", {
    name: "Family",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const routine = await inSpace<Routine>(owner, home.id, "routines/create", {
    botId: bot.id,
    name: "Weekly groceries",
    prompt: "Draft the grocery list.",
    crons: ["0 9 * * 6"],
    timezone: "UTC",
    active: false,
  });

  await member.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await member.goto(`/app/${bot.id}`);
  await expect(member.getByPlaceholder("Message Family")).toBeVisible();
  await openBotPanel(member);
  const row = member.getByRole("button", { name: /Weekly groceries/ });
  await expect(row.getByTestId("routine-owner")).toHaveText("Dana Owner");
  await row.click();

  await expect(member.getByTestId("routine-owner-note")).toHaveText(
    "Only Dana Owner can change this routine.",
  );
  await expect(member.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(member.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // Turning it on saves at once and leaves it the owner's.
  const saved = member.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );
  await member.getByRole("switch", { name: "Active", exact: true }).click();
  await saved;
  const listed = await inSpace<Routine[]>(owner, home.id, "routines/list", { botId: bot.id });
  expect(listed.find((item) => item.id === routine.id)).toMatchObject({
    active: true,
    runsAs: { name: "Dana Owner", isViewer: true },
  });
  await captureScreenshot(member, testInfo, "routine-another-members");

  await member.getByRole("button", { name: "Make a copy" }).click();
  await expect(member.getByLabel("Name", { exact: true })).toHaveValue("Weekly groceries (copy)");
  await expect(member.getByLabel("Name", { exact: true })).toBeEnabled();
  await expect(member.getByTestId("routine-owner-note")).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});
