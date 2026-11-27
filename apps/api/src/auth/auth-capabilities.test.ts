import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountAuthCapabilities } from "./auth-capabilities.js";

const auth = {
  registrationOpen: vi.fn(() => true),
  ssoAvailability: () => null,
  emailCodeSignIn: false,
  passkeyRpId: null,
};

/** The route reads a handful of env fields and serves the same JSON either way. */
const envBase = {
  passwordAuth: true,
  webOrigin: "https://web.example.test",
  oidc: undefined,
  social: [],
  demoAccount: null,
};

function mount(env: Record<string, unknown>) {
  const app = new Hono();
  mountAuthCapabilities(app, {
    env: env as never,
    auth: auth as never,
    email: undefined,
    billing: undefined,
  });
  return app;
}

async function registrationOpen(env: Record<string, unknown>) {
  const app = mount(env);
  const response = await app.request("/api/auth/capabilities");
  expect(response.ok).toBe(true);
  return ((await response.json()) as Record<string, unknown>).registrationOpen;
}

describe("auth capabilities registrationOpen", () => {
  it("follows the signup policy on a normal deployment", async () => {
    expect(await registrationOpen({ ...envBase, signupsEnabled: "false" })).toBe(false);
    expect(await registrationOpen({ ...envBase, signupsEnabled: "true" })).toBe(true);
    expect(await registrationOpen({ ...envBase })).toBe(true);
  });

  it("answers per-request for the app-managed local stack", async () => {
    auth.registrationOpen.mockReturnValueOnce(false);
    expect(await registrationOpen({ ...envBase, desktopStackToken: "stack-token" })).toBe(false);
  });
});
