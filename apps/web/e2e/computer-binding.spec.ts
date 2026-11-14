import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, runAsSystem } from "@rakazo/db";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("settings identifies the computer bound to bots among two connected computers", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `computer-binding-${randomUUID()}@rakazo.test`,
    "password12",
    "Computer Settings",
  );
  await completeOnboarding(page);
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    // Real pairing API and database; seeded live connection rows stand in for two desktops.
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
    const settings = await openUserSettings(page);
    const computers = settings.getByTestId("computer-devices");
    await expect(computers.getByText("Bound to bots", { exact: true })).toHaveCount(1);
    await expect(computers.getByText("Desk PC").locator("..")).toHaveText("Desk PCBound to bots");
    await expect(computers.getByText("Laptop").locator("..")).toHaveText("LaptopConnected");
    await computers.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "computer-binding-two-connected");
    await computers.getByRole("button", { name: "Remove Desk PC" }).click();
    await expect(computers.getByText("Laptop").locator("..")).toHaveText("LaptopBound to bots");
    await captureScreenshot(page, testInfo, "computer-binding-after-removal");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});
