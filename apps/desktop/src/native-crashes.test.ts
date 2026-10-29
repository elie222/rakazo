import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  on: vi.fn(),
  readPrivateFile: vi.fn(),
  writePrivateFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => [{ name: "crash.dmp", isFile: () => true }]),
  stat: vi.fn(async () => ({ mtimeMs: 200 })),
}));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => `/fake/${key}`, on: mocks.on },
  crashReporter: { start: mocks.start },
}));
vi.mock("node:fs/promises", () => ({ readdir: mocks.readdir, stat: mocks.stat }));
vi.mock("./setup-store.js", () => ({
  readPrivateFile: mocks.readPrivateFile,
  writePrivateFile: mocks.writePrivateFile,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
const base = "https://app.example.com";
const checkpoint = {
  connection: createHash("sha256").update(base).digest("hex"),
  enabled: true,
  checkedAt: 100,
};

describe("native crash metadata", () => {
  it("reports a previous native crash only to the same connection, without reading dump contents", async () => {
    mocks.readPrivateFile.mockResolvedValue(JSON.stringify(checkpoint));
    const capture = vi.fn();
    const native = await import("./native-crashes.js");
    native.configureNativeCrashReporting(base, capture);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(mocks.start).toHaveBeenCalledWith({ uploadToServer: false });
    expect(capture).toHaveBeenCalledWith(expect.any(Error), "desktop.startup", {
      "native.crash": "true",
    });
    native.configureNativeCrashReporting("https://other.example.com", capture);
    await vi.waitFor(() => expect(mocks.writePrivateFile).toHaveBeenCalledTimes(2));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(mocks.readdir).toHaveBeenCalledTimes(3);
  });

  it.each([null, { ...checkpoint, enabled: false }])(
    "skips dump scans for an inactive checkpoint: %j",
    async (saved) => {
      mocks.readPrivateFile.mockResolvedValue(JSON.stringify(saved));
      const native = await import("./native-crashes.js");
      const capture = vi.fn();
      native.configureNativeCrashReporting(base, capture);
      await vi.waitFor(() => expect(mocks.writePrivateFile).toHaveBeenCalledTimes(1));
      expect(mocks.readdir).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it("drops in-flight metadata scans when the connection is disabled", async () => {
    let release!: (value: string) => void;
    mocks.readPrivateFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const native = await import("./native-crashes.js");
    const capture = vi.fn();
    native.configureNativeCrashReporting(base, capture);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    native.disableNativeCrashReporting();
    release(JSON.stringify(checkpoint));
    await vi.waitFor(() => expect(mocks.writePrivateFile).toHaveBeenCalled());
    expect(capture).not.toHaveBeenCalled();
  });
});
