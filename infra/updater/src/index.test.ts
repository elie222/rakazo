import { describe, expect, it } from "vitest";
import { createUpdaterApp } from "./index.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const token = "updater-token-for-tests";
const app = createUpdaterApp(
  resolveUpdaterConfig({
    RAKAZO_DEPLOY_DIR: "/rakazo-updater-tests-no-such-directory",
    RAKAZO_UPDATER_TOKEN: token,
  }),
);
const authorized = { authorization: `Bearer ${token}`, "content-type": "application/json" };

describe("updater HTTP surface", () => {
  it("answers health without credentials, for the compose healthcheck", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "updater" });
  });

  it("rejects every privileged route without the shared token", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/state"],
      ["POST", "/plan"],
      ["POST", "/apply"],
      ["POST", "/rollback"],
    ];
    for (const [method, pathname] of routes) {
      const response = await app.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a wrong or malformed token", async () => {
    for (const authorization of [`Bearer ${"x".repeat(token.length)}`, token, "Basic abc"]) {
      const response = await app.request("/state", { headers: { authorization } });
      expect(response.status).toBe(401);
    }
  });

  it("re-validates the repository URL at its own boundary", async () => {
    const cases = [
      "http://github.com/a/b",
      "file:///etc/passwd",
      "https://user:pw@github.com/a/b",
      "--upload-pack=id",
      "https://github.com/a/b?x=1",
    ];
    for (const repoUrl of cases) {
      const response = await app.request("/apply", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({ repoUrl, branch: "main" }),
      });
      expect(response.status, repoUrl).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error, repoUrl).toBeTruthy();
    }
  });

  it("re-validates the branch at its own boundary", async () => {
    const response = await app.request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "--exec=id" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a fork build when the deployment has no checkout to build from", async () => {
    const response = await app.request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/someone/rakazo", branch: "main" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/no \.git directory/);
  });

  it("refuses a rollback when no previous tag was recorded", async () => {
    const response = await app.request("/rollback", { method: "POST", headers: authorized });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/nothing to roll back/);
  });

  it("reports the deployment it manages without touching Docker", async () => {
    const response = await app.request("/state", { headers: authorized });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployDir: "/rakazo-updater-tests-no-such-directory",
      currentTag: "local",
      previousTag: null,
      checkout: { present: false },
    });
  });
});
