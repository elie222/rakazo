import { describe, expect, it } from "vitest";
import { resolveVersionNotice } from "./version-notice.js";

const client = { version: "0.1.0", revision: "aaaaaaa1" };

describe("resolveVersionNotice", () => {
  it("says nothing when everything matches", () => {
    expect(resolveVersionNotice({ client, clientKind: "browser", server: client })).toBeNull();
  });

  it("says nothing when the server has not answered yet", () => {
    expect(
      resolveVersionNotice({
        client,
        clientKind: "desktop",
        server: null,
      }),
    ).toBeNull();
  });

  it("offers a reload to a browser on a stale build", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "bbbbbbb2" },
    });
    expect(notice).toMatchObject({ action: "reload", actionLabel: "Reload" });
    expect(notice?.key).toContain("bbbbbbb2");
  });

  it("never offers a reload to a desktop build", () => {
    const notice = resolveVersionNotice({
      client,
      clientKind: "desktop",
      server: { version: "0.2.0" },
    });
    expect(notice?.action).toBeNull();
    expect(notice?.title).toContain("desktop app is behind");
  });

  it("keys a skew notice by the server build so a new skew re-raises it", () => {
    const first = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "bbb" },
    });
    const second = resolveVersionNotice({
      client,
      clientKind: "browser",
      server: { version: "0.1.0", revision: "ccc" },
    });
    expect(first?.key).not.toBe(second?.key);
  });
});
