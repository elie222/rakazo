import { describe, expect, it } from "vitest";
import {
  compareVersions,
  describeVersionSkew,
  isComparableVersion,
  versionSkewNotice,
} from "./version-skew.js";

describe("compareVersions", () => {
  it("orders releases by number, not by string", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });

  it("ignores prerelease and build metadata", () => {
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+abc", "1.2.3")).toBe(0);
  });

  it("treats unparseable versions as incomparable", () => {
    expect(isComparableVersion("nightly")).toBe(false);
    expect(isComparableVersion("1.2.3.4")).toBe(false);
    expect(isComparableVersion("0.1.0")).toBe(true);
    expect(compareVersions("nightly", "0.1.0")).toBe(0);
  });
});

describe("describeVersionSkew", () => {
  it("matches when the version and commit agree", () => {
    expect(
      describeVersionSkew(
        { version: "0.1.0", revision: "abc123" },
        { version: "0.1.0", revision: "ABC123" },
      ),
    ).toMatchObject({ status: "match" });
  });

  it("matches when only one side knows its commit", () => {
    expect(
      describeVersionSkew({ version: "0.1.0", revision: "abc123" }, { version: "0.1.0" }),
    ).toMatchObject({ status: "match" });
    expect(
      describeVersionSkew({ version: "0.1.0" }, { version: "0.1.0", revision: null }),
    ).toMatchObject({ status: "match" });
  });

  it("ranks the release version ahead of the commit", () => {
    expect(describeVersionSkew({ version: "0.1.0" }, { version: "0.2.0" })).toMatchObject({
      status: "client-behind",
    });
    expect(describeVersionSkew({ version: "0.3.0" }, { version: "0.2.0" })).toMatchObject({
      status: "client-ahead",
    });
  });

  it("falls back to the commit when the versions are equal", () => {
    expect(
      describeVersionSkew(
        { version: "0.1.0", revision: "aaaaaaa" },
        { version: "0.1.0", revision: "bbbbbbb" },
      ),
    ).toMatchObject({ status: "build-differs" });
  });

  it("gives up rather than guessing when a version is unparseable", () => {
    expect(
      describeVersionSkew(
        { version: "dev", revision: "aaa" },
        { version: "0.1.0", revision: "bbb" },
      ),
    ).toMatchObject({ status: "unknown" });
  });
});

describe("versionSkewNotice", () => {
  const client = { version: "0.1.0", revision: "aaaaaaa1" };

  it("says nothing when the builds match or cannot be compared", () => {
    expect(versionSkewNotice(describeVersionSkew(client, client), "browser")).toBeNull();
    expect(
      versionSkewNotice(describeVersionSkew({ version: "dev" }, { version: "0.1.0" }), "desktop"),
    ).toBeNull();
  });

  it("only ever asks a browser to reload", () => {
    const skew = describeVersionSkew(client, { version: "0.1.0", revision: "bbbbbbb2" });
    const notice = versionSkewNotice(skew, "browser");
    expect(notice?.action).toBe("reload");
    expect(notice?.detail).toContain("aaaaaaa");
    expect(notice?.detail).toContain("bbbbbbb");
  });

  it("tells a desktop user which side is behind", () => {
    const behind = versionSkewNotice(
      describeVersionSkew({ version: "0.1.0" }, { version: "0.2.0" }),
      "desktop",
    );
    expect(behind?.action).toBe("update-desktop");
    expect(behind?.title).toContain("desktop app is behind");

    const ahead = versionSkewNotice(
      describeVersionSkew({ version: "0.3.0" }, { version: "0.2.0" }),
      "desktop",
    );
    expect(ahead?.action).toBe("update-server");
    expect(ahead?.title).toContain("server is behind");
  });

  it("never suggests a reload for a desktop build, which ships its own assets", () => {
    const notice = versionSkewNotice(
      describeVersionSkew(client, { version: "0.1.0", revision: "bbbbbbb2" }),
      "desktop",
    );
    expect(notice?.action).toBeNull();
    expect(notice?.detail).toContain("keep working");
  });

  it("always tells the reader the app still works", () => {
    for (const server of [{ version: "0.2.0" }, { version: "0.0.9" }]) {
      for (const kind of ["browser", "desktop"] as const) {
        const notice = versionSkewNotice(describeVersionSkew(client, server), kind);
        expect(notice?.detail.toLowerCase(), `${kind} ${server.version}`).toMatch(
          /keeps? working|keep working/,
        );
      }
    }
  });
});
