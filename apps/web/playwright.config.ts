import { defineConfig, devices } from "@playwright/test";
import { isRealSandboxProvider } from "./e2e/helpers";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${webPort}`;
const realSandbox = isRealSandboxProvider();
const boxSandbox = process.env.SANDBOX_PROVIDER === "box";
const reporters = [
  ...(process.env.CI ? ([["github"]] as const) : []),
  ["list"] as const,
  ["html", { open: "never", outputFolder: "../../playwright-report" }] as const,
];

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: realSandbox ? 1 : undefined,
  timeout: boxSandbox ? 600_000 : realSandbox ? 300_000 : 120_000,
  expect: { timeout: boxSandbox ? 300_000 : realSandbox ? 90_000 : 20_000 },
  reporter: reporters,
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
