import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, runAsSystem } from "@rakazo/db";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("Devices lists connected computers and signed-in phones", async ({ page }, testInfo) => {
  const email = `computer-binding-${randomUUID()}@rakazo.test`;
  await signup(page, email, "password12", "Computer Settings");
  await completeOnboarding(page);
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    // Real pairing API and database; seeded live connection rows stand in for two desktops.
    // Desk PC connected last, yet Laptop, paired first, stays the one bots use.
    for (const [index, name] of ["Laptop", "Desk PC"].entries()) {
      const response = await page.request.post("/api/devices/pair", {
        data: { name, platform: "linux" },
      });
      expect(response.ok()).toBe(true);
      const { deviceId } = await response.json();
      await runAsSystem("seed connected computers for settings", () =>
        prisma.userDeviceConnection.create({
          data: {
            deviceId,
            connectionId: randomUUID(),
            address: "http://127.0.0.1:1",
            connectedAt: new Date(Date.now() - (1 - index) * 1000),
          },
        }),
      );
    }
    await runAsSystem("seed a signed-in phone for settings", async () => {
      const { id: sessionId } = await prisma.session.findFirstOrThrow({
        where: { user: { email } },
        select: { id: true },
      });
      await prisma.mobileDevice.create({
        data: { sessionId, platform: "ios", name: null, lastSeenAt: new Date(0) },
      });
    });
    const settings = await openUserSettings(page, "computer");
    await expect(settings.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
    const computers = settings.getByTestId("computer-devices");
    const laptop = computers.getByTestId("computer-device-row").filter({ hasText: "Laptop" });
    const desk = computers.getByTestId("computer-device-row").filter({ hasText: "Desk PC" });
    await expect(computers.getByText("Bound to bots", { exact: true })).toHaveCount(1);
    await expect(laptop.getByText("Bound to bots", { exact: true })).toBeVisible();
    await expect(laptop.getByText("Online", { exact: true })).toBeVisible();
    await expect(desk.getByText("Online", { exact: true })).toBeVisible();
    await expect(computers.getByText("iPhone", { exact: true })).toBeVisible();
    await expect(computers.getByText("Offline", { exact: true })).toHaveCount(1);
    await expect(computers.getByRole("button", { name: "Manage iPhone" })).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "Connect more devices" })).toBeVisible();
    await computers.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "device-settings");
    await laptop.getByRole("button", { name: "Manage Laptop" }).click();
    await laptop.getByRole("button", { name: "Remove Laptop" }).click();
    await expect(desk.getByText("Bound to bots", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "computer-binding-after-removal");
    await settings.getByRole("button", { name: "Connect your iPhone" }).click();
    await expect(settings.getByRole("link", { name: "Download Rakazo" })).toBeVisible();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});
