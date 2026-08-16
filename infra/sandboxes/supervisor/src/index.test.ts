import { resolveSupervisorToken } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { supervisorApp } from "./index.js";
import {
  assertRequestIdentity,
  containerActionStep,
  hasValidBearerToken,
  interactiveScreenCommand,
  normalizeWorkspaceRelative,
  parseObservation,
} from "./supervisor-logic.js";

const token = resolveSupervisorToken(process.env);

describe("sandbox supervisor HTTP boundary", () => {
  it("keeps health public while every computer route requires the service token", async () => {
    const health = await supervisorApp.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const protectedRequests: Array<[string, string]> = [
      ["POST", "/computers"],
      ["GET", "/computers/id"],
      ["POST", "/computers/id/exec"],
      ["POST", "/computers/id/observe"],
      ["POST", "/computers/id/actions"],
      ["GET", "/computers/id/files"],
      ["POST", "/computers/id/files"],
      ["GET", "/computers/id/screen"],
      ["POST", "/computers/id/screen-mode"],
      ["POST", "/computers/id/input"],
      ["POST", "/computers/id/stop"],
      ["DELETE", "/computers/id"],
    ];

    for (const [method, pathname] of protectedRequests) {
      const response = await supervisorApp.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects malformed and incorrect bearer credentials", () => {
    expect(hasValidBearerToken(undefined, token)).toBe(false);
    expect(hasValidBearerToken(token, token)).toBe(false);
    expect(hasValidBearerToken("Basic credentials", token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${"x".repeat(token.length)}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects a provision request whose identity headers do not match its body", async () => {
    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "other-bot",
        "x-rakazo-workspace-id": "workspace",
      },
      body: JSON.stringify({
        botId: "bot",
        workspaceId: "workspace",
        homePath: "/tmp/never-used",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "computer identity mismatch" });
  });
});

describe("sandbox supervisor input containment", () => {
  it("normalizes portable paths and rejects lexical traversal", () => {
    expect(normalizeWorkspaceRelative("/notes\\result.txt")).toBe("notes/result.txt");
    expect(normalizeWorkspaceRelative("//notes///result.txt")).toBe("notes/result.txt");
    expect(() => normalizeWorkspaceRelative("../outside")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/./result.txt")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/../outside")).toThrow(/escapes/);
  });

  it("requires both bot and workspace identities to match", () => {
    expect(() =>
      assertRequestIdentity("bot", "workspace", { botId: "bot", workspaceId: "workspace" }),
    ).not.toThrow();
    expect(() =>
      assertRequestIdentity(undefined, "workspace", { botId: "bot", workspaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      assertRequestIdentity("bot", "other", { botId: "bot", workspaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
  });

  it("bounds scroll and wait actions before sending them to the computer", () => {
    expect(containerActionStep({ kind: "wait", ms: 99_999 })).toEqual({ waitMs: 5_000 });
    expect(containerActionStep({ kind: "wait", ms: -1 })).toEqual({ waitMs: 0 });
    expect(containerActionStep({ kind: "scroll", direction: "up", amount: 99 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "20", "4"],
    });
  });

  it("keeps the viewer read-only and uses a separate process for takeover control", () => {
    expect(interactiveScreenCommand(false)).toMatch(/pkill .*5901/);
    expect(interactiveScreenCommand(false)).not.toMatch(/x11vnc -display/);
    expect(interactiveScreenCommand(true)).toMatch(/x11vnc -display .* -rfbport 5901/);
    expect(interactiveScreenCommand(true)).toMatch(/6081/);
    expect(interactiveScreenCommand(true)).not.toMatch(/-rfbport 5900/);
  });

  it("parses a captured frame without trusting optional desktop metadata", () => {
    expect(
      parseObservation(
        [
          "GEOM 1280 800",
          "CURSOR X=12 Y=34 SCREEN=0 WINDOW=99",
          "WINDOW 99",
          "TITLE Browser",
          "IMAGE AQID",
        ].join("\n"),
      ),
    ).toEqual({
      image: "AQID",
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 12, y: 34 },
      activeWindow: { id: "99", title: "Browser" },
    });
    expect(() => parseObservation("GEOM 1280 800\nIMAGE ")).toThrow(/no image/);
  });
});
