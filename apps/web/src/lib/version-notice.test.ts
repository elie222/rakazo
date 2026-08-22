import type { DesktopUpdateState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveVersionNotice } from "./version-notice.js";

const client = { version: "0.1.0", revision: "aaaaaaa1" };

function desktopState(overrides: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    phase: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    percent: null,
    message: null,
    checkedAt: null,
    ...overrides,
  };
}

describe("resolveVersionNotice", () => {
  it("says nothing when everything matches", () => {
    expect(
      resolveVersionNotice({ client, clientKind: "browser", server: client, desktop: null }),
    ).toBeNull();
  });

  it("says nothing when the server has not answered yet", () => {
    expect(
      resolveVersionNotice({
        client,
        clientKind: "desktop",
        server: null,
        desktop: desktopState({}),
      }),
    ).toBeNull();
  });

  it("offers a reload to a browser on a stale build", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "bbbbbbb2" },
      desktop: null,
    });
    expect(notice).toMatchObject({ action: "reload", actionLabel: "Reload" });
    expect(notice?.key).toContain("bbbbbbb2");
  });

  it("never offers a reload to a desktop build", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "desktop",
      server: { version: "0.2.0" },
      desktop: desktopState({}),
    });
    expect(notice?.action).toBeNull();
    expect(notice?.title).toContain("desktop app is behind");
  });

  it("prefers a ready desktop release over the version warning it resolves", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "desktop",
      server: { version: "0.2.0" },
      desktop: desktopState({ phase: "ready", availableVersion: "0.2.0" }),
    });
    expect(notice).toMatchObject({
      action: "install-desktop",
      actionLabel: "Restart and install",
      key: "desktop-ready:0.2.0",
    });
  });

  it("shows download progress without an action", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "desktop",
      server: client,
      desktop: desktopState({ phase: "downloading", availableVersion: "0.2.0", percent: 37 }),
    });
    expect(notice).toMatchObject({ action: null, busy: true });
    expect(notice?.detail).toContain("37%");
  });

  it("offers the download when a release is waiting", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "desktop",
      server: client,
      desktop: desktopState({ phase: "available", availableVersion: "0.2.0" }),
    });
    expect(notice).toMatchObject({ action: "download-desktop", key: "desktop-available:0.2.0" });
  });

  it("stays quiet for a desktop install with no feed and a matching server", () => {
    expect(
      resolveVersionNotice({
        client,
        clientKind: "desktop",
        server: client,
        desktop: desktopState({ phase: "unsupported", message: "No desktop releases yet." }),
      }),
    ).toBeNull();
  });

  it("keys a skew notice by the server build so a new skew re-raises it", () => {
    const first = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "bbb" },
      desktop: null,
    });
    const second = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "ccc" },
      desktop: null,
    });
    expect(first?.key).not.toBe(second?.key);
  });
});
