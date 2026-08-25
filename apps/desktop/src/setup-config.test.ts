import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_WEB_URL,
  isRakazoHealth,
  normalizeServerUrl,
  parseSetupInput,
  parseStoredSetup,
  probeFailureMessage,
  resolveStartupTarget,
  safeExternalUrl,
  serializeSetup,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "./setup-config.js";

describe("server address normalization", () => {
  it("assumes http locally and https for a bare public host", () => {
    expect(normalizeServerUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeServerUrl("192.168.1.20:3100")).toBe("http://192.168.1.20:3100");
    expect(normalizeServerUrl("rakazo.example.com")).toBe("https://rakazo.example.com");
  });

  it("keeps an explicit secure scheme and port but stores only the origin", () => {
    expect(normalizeServerUrl("https://rakazo.example.com")).toBe("https://rakazo.example.com");
    expect(normalizeServerUrl("https://rakazo.example.com:8443/team")).toBe(
      "https://rakazo.example.com:8443",
    );
  });

  it("trims surrounding space, trailing slashes, queries, and fragments", () => {
    expect(normalizeServerUrl("  http://127.0.0.1:5173/  ")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173///")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173/?next=/bots#top")).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("rejects cleartext public servers but permits private-network development", () => {
    expect(normalizeServerUrl("http://rakazo.example.com")).toBeNull();
    expect(normalizeServerUrl("http://10.0.0.8:3100")).toBe("http://10.0.0.8:3100");
    expect(normalizeServerUrl("http://[fd00::1]:3100")).toBe("http://[fd00::1]:3100");
  });

  it("rejects cleartext link-local addresses used by cloud metadata endpoints", () => {
    expect(normalizeServerUrl("http://169.254.169.254")).toBeNull();
    expect(normalizeServerUrl("http://169.254.1.1:80")).toBeNull();
    expect(normalizeServerUrl("http://[fe80::1]:3100")).toBeNull();
    // HTTPS to link-local still normalizes; the health probe must match Rakazo.
    expect(normalizeServerUrl("https://169.254.169.254")).toBe("https://169.254.169.254");
  });

  it.each(["", "   ", "not a url", "ftp://example.com", "file:///etc/passwd", "http://"])(
    "rejects an address that cannot reach a Rakazo server (%s)",
    (value) => {
      expect(normalizeServerUrl(value)).toBeNull();
    },
  );

  it("rejects embedded credentials rather than writing them to disk", () => {
    expect(normalizeServerUrl("https://user:secret@rakazo.example.com")).toBeNull();
  });
});

describe("saved setup", () => {
  it("round-trips through the on-disk format", () => {
    const setup = { mode: "existing", serverUrl: "https://rakazo.example.com" } as const;
    expect(parseStoredSetup(serializeSetup(setup))).toEqual(setup);
  });

  it("normalizes the address it reads back", () => {
    expect(parseStoredSetup('{"mode":"new","serverUrl":"127.0.0.1:5173/"}')).toEqual({
      mode: "new",
      serverUrl: "http://127.0.0.1:5173",
    });
  });

  it.each([
    ["not json", "{oops"],
    ["a non-object", '"nope"'],
    ["an unknown mode", '{"mode":"other","serverUrl":"http://127.0.0.1:5173"}'],
    ["a missing address", '{"mode":"new"}'],
    ["an unusable address", '{"mode":"new","serverUrl":"ftp://example.com"}'],
  ])("discards %s so setup runs again", (_label, raw) => {
    expect(parseStoredSetup(raw)).toBeNull();
  });

  it("rejects an untrusted payload that is not a setup", () => {
    expect(parseSetupInput(null)).toBeNull();
    expect(parseSetupInput({ mode: "new", serverUrl: 5173 })).toBeNull();
  });

  it("keeps the new-instance choice on this computer", () => {
    expect(parseSetupInput({ mode: "new", serverUrl: "http://192.168.1.20:3100" })).toBeNull();
    expect(parseSetupInput({ mode: "existing", serverUrl: "http://192.168.1.20:3100" })).toEqual({
      mode: "existing",
      serverUrl: "http://192.168.1.20:3100",
    });
  });
});

describe("startup target", () => {
  const saved = { mode: "existing", serverUrl: "https://rakazo.example.com" } as const;

  it("runs setup on a first launch", () => {
    expect(resolveStartupTarget({})).toEqual({ kind: "setup" });
  });

  it("opens the saved instance on later launches", () => {
    expect(resolveStartupTarget({ saved })).toEqual({
      kind: "app",
      url: "https://rakazo.example.com",
      source: "saved",
    });
  });

  it("lets RAKAZO_WEB_URL point the shell anywhere without touching saved setup", () => {
    expect(resolveStartupTarget({ envUrl: "http://127.0.0.1:4321", saved })).toEqual({
      kind: "app",
      url: "http://127.0.0.1:4321",
      source: "env",
    });
  });

  it("ignores an empty RAKAZO_WEB_URL", () => {
    expect(resolveStartupTarget({ envUrl: "   ", saved }).kind).toBe("app");
    expect(resolveStartupTarget({ envUrl: "   ", saved })).toMatchObject({ source: "saved" });
  });

  it("re-runs setup when forced, even with saved configuration", () => {
    expect(resolveStartupTarget({ saved, forceSetup: true })).toEqual({ kind: "setup" });
  });

  it("re-runs setup when the saved address is unusable", () => {
    expect(resolveStartupTarget({ saved: { mode: "new", serverUrl: "nope://x" } })).toEqual({
      kind: "setup",
    });
    expect(
      resolveStartupTarget({
        saved: { mode: "new", serverUrl: "http://192.168.1.20:3100" },
      }),
    ).toEqual({ kind: "setup" });
  });
});

describe("bundled renderer eligibility", () => {
  it("stands in for http(s) origins only", () => {
    expect(servesBundledRenderer(DEFAULT_LOCAL_WEB_URL)).toBe(true);
    expect(servesBundledRenderer("https://rakazo.example.com")).toBe(true);
    expect(servesBundledRenderer("data:text/html,<p>fixture</p>")).toBe(false);
    expect(servesBundledRenderer("nonsense")).toBe(false);
  });
});

describe("remote-content isolation", () => {
  it("uses a stable, opaque session partition per server origin", () => {
    const first = sessionPartitionForServerUrl("https://one.example.com/path");
    expect(first).toBe(sessionPartitionForServerUrl("https://one.example.com/other"));
    expect(first).not.toBe(sessionPartitionForServerUrl("https://one.example.com:8443"));
    expect(first).toMatch(/^persist:rakazo-[a-f0-9]{24}$/);
    expect(first).not.toContain("one.example.com");
    expect(sessionPartitionForServerUrl("data:text/html,fixture")).toBeNull();
  });

  it("opens only web URLs outside Electron", () => {
    expect(safeExternalUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeExternalUrl("mailto:person@example.com")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("Rakazo health response", () => {
  it("requires the public RPC health contract", () => {
    expect(isRakazoHealth({ json: { ok: true, version: "0.1.0" } })).toBe(true);
    expect(isRakazoHealth({ json: { ok: true } })).toBe(false);
    expect(isRakazoHealth({ ok: true, version: "0.1.0" })).toBe(false);
  });
});

describe("probe failures", () => {
  it.each([
    ["TimeoutError", "Timed out reaching that address."],
    ["AbortError", "Timed out reaching that address."],
  ])("explains %s", (name, expected) => {
    const error = new Error("stopped");
    error.name = name;
    expect(probeFailureMessage(error)).toBe(expected);
  });

  it.each([
    ["net::ERR_CONNECTION_REFUSED", "Nothing is listening at that address yet."],
    ["net::ERR_NAME_NOT_RESOLVED", "That host could not be found."],
    ["net::ERR_CERT_AUTHORITY_INVALID", "The server's HTTPS certificate was rejected."],
    ["something else entirely", "Could not reach that address."],
  ])("explains %s", (message, expected) => {
    expect(probeFailureMessage(new Error(message))).toBe(expected);
  });
});
