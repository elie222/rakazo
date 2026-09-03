import { defineConfig, devices } from "@playwright/test";
import { resolveWwwPort } from "./www-port.mjs";

const port = resolveWwwPort();
const baseURL = process.env.PLAYWRIGHT_WWW_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../web/test-results/www-marketing",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ...(process.env.CI ? ([["github"]] as const) : []),
    ["list"] as const,
    ["html", { open: "never", outputFolder: "../../playwright-report-www" }] as const,
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
