import { LOCAL_SETTINGS_RPC, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountLocalSettings, validLocalSettingsToken } from "./local-settings.js";

const token = "ab".repeat(32);
function fixture(
  configuredToken: string | undefined = token,
  ownerUserId: string | null = "owner",
) {
  const findUnique = vi.fn(async () => ({ ownerUserId }));
  const findFirst = vi.fn(async () => ({
    userId: "owner",
    spaceId: "owner-default",
    member: { user: { email: "owner@example.test" } },
  }));
  const handle = vi.fn(async () => ({
    matched: true,
    response: new Response('{"json":{"ok":true}}'),
  }));
  const app = new Hono();
  mountLocalSettings(app, {
    token: configuredToken,
    prisma: { deploymentSettings: { findUnique }, spaceMember: { findFirst } } as never,
    rpc: { handle } as never,
  });
  function request(procedure: string, supplied: string | null = token, method = "POST") {
    return app.request(`${LOCAL_SETTINGS_RPC}/${procedure}`, {
      method,
      headers: {
        ...(supplied === null ? {} : { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied }),
        "x-rakazo-space-id": "someone-elses-space",
        cookie: "session=fake",
      },
    });
  }
  return { request, findUnique, findFirst, handle };
}

describe("local settings authority", () => {
  it("requires a configured, exact capability, not a cookie", async () => {
    const f = fixture();
    for (const supplied of [null, "", "cd".repeat(32), `${token}x`]) {
      expect((await f.request("models/list", supplied)).status).toBe(401);
    }
    expect(f.findUnique).not.toHaveBeenCalled();
    expect(validLocalSettingsToken(undefined, token)).toBe(false);
    expect(validLocalSettingsToken("", "")).toBe(false);
    expect(validLocalSettingsToken(token, token)).toBe(true);
  });

  it("denies general app access and noncanonical paths even with the capability", async () => {
    const f = fixture();
    for (const procedure of [
      "bots/list",
      "spaces/list",
      "models/list/",
      "models%2Flist",
      "integrationSetup/save/extra",
    ]) {
      expect((await f.request(procedure)).status).toBe(403);
    }
    expect((await f.request("models/list", token, "GET")).status).toBe(403);
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.findUnique).not.toHaveBeenCalled();
  });

  it("uses the deployment owner's default space and ignores client space selection", async () => {
    const f = fixture();
    for (const procedure of [
      "models/connect",
      "models/setDefault",
      "integrationSetup/get",
      "integrationSetup/save",
    ]) {
      expect((await f.request(procedure)).status).toBe(200);
    }
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner" } }),
    );
    expect(f.handle).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        prefix: LOCAL_SETTINGS_RPC,
        context: expect.objectContaining({
          actor: expect.objectContaining({
            userId: "owner",
            spaceId: "owner-default",
            isDeploymentOwner: true,
          }),
        }),
      }),
    );
  });

  it("requires an existing owner account", async () => {
    const f = fixture(token, null);
    expect((await f.request("models/list")).status).toBe(409);
    expect(f.handle).not.toHaveBeenCalled();
  });
});
