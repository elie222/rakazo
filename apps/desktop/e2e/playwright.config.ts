import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // CI's Production builds job is otherwise one Electron at a time for ~2 minutes.
  fullyParallel: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
