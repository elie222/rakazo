import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_WEB_URL,
  normalizeServerUrl,
  parseSetupInput,
  parseStoredSetup,
  probeFailureMessage,
  resolveStartupTarget,
  serializeSetup,
  servesBundledRenderer,
} from "./setup-config.js";

describe("server address normalization", () => {
  it("assumes http for a bare host or host:port", () => {
    expect(normalizeServerUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeServerUrl("rakazo.example.com")).toBe("http://rakazo.example.com");
  });

  it("keeps an explicit scheme, port, and base path", () => {
    expect(normalizeServerUrl("https://rakazo.example.com")).toBe("https://rakazo.example.com");
    expect(normalizeServerUrl("https://rakazo.example.com:8443/team")).toBe(
      "https://rakazo.example.com:8443/team",
    );
  });

  it("trims surrounding space, trailing slashes, queries, and fragments", () => {
    expect(normalizeServerUrl("  http://127.0.0.1:5173/  ")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173///")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173/?next=/bots#top")).toBe(
      "http://127.0.0.1:5173",
    );
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
