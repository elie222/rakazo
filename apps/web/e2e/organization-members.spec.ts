import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

type OrganizationList = {
  activeOrganizationId: string;
  organizations: Array<{ id: string; name: string; defaultSpaceId: string; role: string }>;
};

test("an owner invites someone to the organization, who joins with a private Space", async ({
  browser,
}, testInfo) => {
  const owner = await browser.newContext();
  const invitee = await browser.newContext();
  await owner.grantPermissions(["clipboard-read", "clipboard-write"]);
  const ownerPage = await owner.newPage();
  const inviteePage = await invitee.newPage();
  const stamp = Date.now();
  const inviteeEmail = `org-invitee-${stamp}@rakazo.test`;

  await signup(ownerPage, `org-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(ownerPage);
  const { activeOrganizationId } = await rpc<OrganizationList>(ownerPage, "organizations/list", {});
  await rpc(ownerPage, "organizations/rename", {
    organizationId: activeOrganizationId,
    name: "Acme",
  });
  const team = await rpc<{ id: string }>(ownerPage, "spaces/create", { name: "Team" });

  // Alone in it, the row offers to invite people.
  let settings = await openUserSettings(ownerPage, "organization");
  const membersRow = settings.getByRole("button", { name: /^Members/ });
  await expect(membersRow).toContainText("Invite people");
  await captureScreenshot(ownerPage, testInfo, "org-members-row-alone");
  await membersRow.click();
  const members = settings.getByTestId("organization-members");
  await expect(members.getByTestId("settings-page-title")).toHaveText("Members");
  await members.getByRole("textbox", { name: "Email" }).fill(inviteeEmail);
  await members.getByRole("button", { name: "Invite", exact: true }).click();
  // This server sends no email, so the link is copied to share by hand.
  await expect(ownerPage.getByText("Invite link copied")).toBeVisible();
  const joinUrl = await ownerPage.evaluate(() => navigator.clipboard.readText());
  expect(joinUrl).toMatch(/\/join\//);
  await expect(members.getByText(inviteeEmail)).toBeVisible();
  await expect(members.getByText("Invited", { exact: true })).toBeVisible();
  await captureScreenshot(ownerPage, testInfo, "org-members-invited");

  await signup(inviteePage, inviteeEmail, "password12", "Bob Invitee");
  await completeOnboarding(inviteePage);
  await inviteePage.goto(new URL(joinUrl).pathname);
  await expect(inviteePage.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await expect(inviteePage.getByText("Ada Owner invited you")).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "org-join");
  await inviteePage.getByRole("button", { name: "Join", exact: true }).click();
  await inviteePage.waitForURL(/\/(app|onboarding)/);

  // They land in a Space of their own there, and none of the owner's.
  const joined = await rpc<OrganizationList>(inviteePage, "organizations/list", {});
  const acme = joined.organizations.find((organization) => organization.name === "Acme")!;
  expect(acme.role).toBe("member");
  expect(acme.defaultSpaceId).not.toBe(activeOrganizationId);
  expect(await inviteePage.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(
    acme.defaultSpaceId,
  );

  await ownerPage.reload();
  settings = await openUserSettings(ownerPage, "organization");
  await expect(settings.getByRole("button", { name: /^Members/ })).toContainText("2");
  await settings.getByRole("button", { name: /^Members/ }).click();
  await expect(settings.getByText("Bob Invitee")).toBeVisible();
  await expect(settings.getByText("Invited", { exact: true })).toHaveCount(0);
  await captureScreenshot(ownerPage, testInfo, "org-members");

  // A Space's owner picks them from the organization instead of sending a link.
  await ownerPage.keyboard.press("Escape");
  const sidebar = ownerPage.locator("aside").first();
  await sidebar.getByRole("button", { name: "Actions for Team" }).click();
  await ownerPage.getByRole("menuitem", { name: "Settings" }).click();
  const spaceSettings = ownerPage.getByTestId("space-members-settings");
  await spaceSettings.getByRole("button", { name: "Invite" }).click();
  await expect(ownerPage.getByRole("menuitem", { name: "Copy invite link" })).toBeVisible();
  await captureScreenshot(ownerPage, testInfo, "space-invite-from-organization");
  await ownerPage.getByRole("menuitem", { name: "Bob Invitee" }).click();
  await expect(spaceSettings.getByText("Bob Invitee")).toBeVisible();
  const teamMembers = await ownerPage.request.post("/rpc/spaces/members/list", {
    headers: { "x-rakazo-space-id": team.id },
    data: { json: { spaceId: team.id } },
  });
  expect(JSON.stringify(await teamMembers.json())).toContain("Bob Invitee");
});
