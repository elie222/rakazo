import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ inspect: vi.fn(), handle: vi.fn(), create: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));
vi.mock("@rakazo/native-runtime", () => ({
  createComputerExecutionRuntime: mock.create.mockImplementation(() => ({
    handle: mock.handle,
    close: async () => {},
  })),
}));

import { supervisorApp } from "./routes.js";

beforeEach(() => {
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.handle.mockReset().mockResolvedValue({ id: "fixture", profiles: [] });
});

function headers(overrides: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "x-rakazo-bot-id": "home",
    "x-rakazo-space-id": "space",
    "x-execution-scope": Buffer.from(
      JSON.stringify({ spaceId: "space", userId: "owner", computerId: "computer" }),
    ).toString("base64url"),
    ...overrides,
  };
}

it.each<Record<string, string>>([
  { authorization: "Bearer invalid" },
  { origin: "https://example.test" },
  { "x-rakazo-bot-id": "another-home" },
  { "x-rakazo-space-id": "another-space" },
  { "x-execution-scope": "invalid" },
])("rejects an untrusted native request before invoking the runtime: %o", async (overrides) => {
  const response = await supervisorApp.request("/computers/container/execution/describe", {
    headers: headers(overrides),
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mock.handle).not.toHaveBeenCalled();
});

it("passes only the authenticated computer scope to the lazy runtime", async () => {
  const response = await supervisorApp.request("/computers/container/execution/describe", {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mock.handle).toHaveBeenCalledWith(
    "describe",
    undefined,
    { spaceId: "space", userId: "owner", computerId: "computer" },
    "home",
    undefined,
  );
  expect(mock.create).toHaveBeenCalledTimes(1);
});

it("rejects invalid methods, oversized frames and malformed bodies before dispatch", async () => {
  const method = await supervisorApp.request("/computers/container/execution/start", {
    headers: headers(),
  });
  expect(method.status).toBe(405);
  for (const body of ["{", JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) })]) {
    const response = await supervisorApp.request("/computers/container/execution/start", {
      method: "POST",
      headers: headers(),
      body,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(mock.handle).not.toHaveBeenCalled();
});

it("sanitizes runtime errors without returning deployment or account details", async () => {
  mock.handle.mockRejectedValueOnce(new Error("fixture-sensitive-value"));
  const response = await supervisorApp.request("/computers/container/execution/describe", {
    headers: headers(),
  });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("fixture-sensitive-value");
});
