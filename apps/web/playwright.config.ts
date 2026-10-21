import { defineConfig, devices } from "@playwright/test";
import { isRealSandboxProvider } from "./e2e/helpers";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${webPort}`;
const realSandbox = isRealSandboxProvider();
const boatSandbox = process.env.SANDBOX_PROVIDER === "boat";
// GitHub Actions shards the suite; each shard writes a blob that the merge job turns into one report.
const reporters = [
  ...(process.env.CI ? ([["github"]] as const) : []),
  ["list"] as const,
  process.env.GITHUB_ACTIONS
    ? (["blob", { outputDir: "../../blob-report" }] as const)
    : (["html", { open: "never", outputFolder: "../../playwright-report" }] as const),
];

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: realSandbox ? 1 : undefined,
  timeout: boatSandbox ? 600_000 : realSandbox ? 300_000 : 120_000,
  expect: { timeout: boatSandbox ? 300_000 : realSandbox ? 90_000 : 20_000 },
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
