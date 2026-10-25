import type { PlaywrightTestConfig } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";

const loadConfig = () =>
  import(new URL("../playwright.config.ts", import.meta.url).href) as Promise<{
    default: PlaywrightTestConfig;
  }>;

vi.mock("../e2e/helpers", () => ({ isRealSandboxProvider: () => false }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps ordinary browser reports and failure artifacts", async () => {
  vi.stubEnv("REMBRIC_E2E_ADMIN_TOKEN", undefined);
  vi.stubEnv("CI", "1");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  const { default: config } = await loadConfig();
  expect(config.reporter).toContainEqual(["blob", { outputDir: "../../blob-report" }]);
  expect(config.use?.trace).toBe("retain-on-failure");
  expect(config.use?.screenshot).toBe("only-on-failure");
  expect(config.use?.video).toBe("retain-on-failure");
});

it("never persists credential-bearing live journey steps or browser recordings", async () => {
  vi.stubEnv("REMBRIC_E2E_ADMIN_TOKEN", "fake-private-journey-token");
  vi.stubEnv("CI", "1");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  const { default: config } = await loadConfig();
  expect(config.reporter).toEqual([["list"]]);
  expect(config.use?.trace).toBe("off");
  expect(config.use?.screenshot).toBe("off");
  expect(config.use?.video).toBe("off");
});
