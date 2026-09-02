import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/**
 * Host-disk settings only render inside the desktop bridge. E2E injects a fake
 * bridge and stubs the hostDisk RPCs so CI can open and screenshot the screen.
 */
test("host disk settings open from account settings in the desktop bridge", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    (
      window as Window & {
        rakazoDesktop?: {
          platform: string;
          window: {
            close: () => Promise<void>;
            minimize: () => Promise<void>;
            toggleMaximize: () => Promise<void>;
            state: () => Promise<{
              minimized: boolean;
              maximized: boolean;
              fullScreen: boolean;
            }>;
          };
          update: {
            state: () => Promise<{
              phase: "unsupported";
              currentVersion: string;
              availableVersion: null;
              percent: null;
              message: null;
              checkedAt: null;
            }>;
            check: () => Promise<unknown>;
            download: () => Promise<unknown>;
            install: () => Promise<unknown>;
          };
          oauth: { onCallback: () => () => void };
          hostDisk: {
            pickFolder: () => Promise<string | null>;
            revokeRoot: (root: string) => Promise<boolean>;
            listGrantedRoots: () => Promise<string[]>;
            list: () => Promise<[]>;
            read: () => Promise<string>;
            write: () => Promise<boolean>;
          };
        };
      }
    ).rakazoDesktop = {
      platform: "darwin",
      window: {
        close: async () => undefined,
        minimize: async () => undefined,
        toggleMaximize: async () => undefined,
        state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
      },
      update: {
        state: async () => ({
          phase: "unsupported",
          currentVersion: "0.0.0",
          availableVersion: null,
          percent: null,
          message: null,
          checkedAt: null,
        }),
        check: async () => undefined,
        download: async () => undefined,
        install: async () => undefined,
      },
      oauth: { onCallback: () => () => undefined },
      hostDisk: {
        pickFolder: async () => "/tmp/rakazo-granted",
        revokeRoot: async () => true,
        listGrantedRoots: async () => ["/tmp/rakazo-granted"],
        list: async () => [],
        read: async () => "",
        write: async () => true,
      },
    };
  });

  await page.route("**/rpc/hostDisk/get", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: false,
          roots: [],
          clientSeenAt: null,
          available: false,
        },
      }),
    }),
  );
  await page.route("**/rpc/hostDisk/setEnabled", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          roots: [],
          clientSeenAt: null,
          available: false,
        },
      }),
    }),
  );

  const stamp = Date.now();
  const userName = `HostDisk ${stamp}`;
  await signup(page, `host-disk-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("host-disk-settings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This computer" })).toBeVisible();
  await page.getByTestId("host-disk-toggle").click();
  await expect(page.getByTestId("host-disk-grant")).toBeVisible();
  await captureScreenshot(page, testInfo, "host-disk-settings");
});
