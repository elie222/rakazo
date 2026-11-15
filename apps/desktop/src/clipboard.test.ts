import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createClipboardHandler } from "./clipboard.js";

/** The handler never reads its caller: `handleIpc` has already checked who is calling. */
const event = null;

function setup() {
  const target = { webContents: {} as WebContents, url: "https://app.example.com" };
  const write = vi.fn();
  return { target, write, handle: createClipboardHandler(() => target, write) };
}

describe("desktop clipboard handler", () => {
  it("writes strings, including empty text", () => {
    const { write, handle } = setup();
    expect(handle(event, "code\ntext")).toBe(true);
    expect(handle(event, "")).toBe(true);
    expect(write.mock.calls).toEqual([["code\ntext"], [""]]);
  });

  it("writes nothing when there is no app window", () => {
    const { write } = setup();
    expect(createClipboardHandler(() => null, write)(event, "text")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 42, {}, ["text"], true])("rejects non-string payload %s", (text) => {
    const { handle, write } = setup();
    expect(handle(event, text)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["http://192.168.1.2:3000", false],
    ["http://app.local:3000", false],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:3000", true],
    ["https://app.example.com", true],
  ])("requires a secure origin for %s", (url, allowed) => {
    const { target, write, handle } = setup();
    target.url = url;
    expect(handle(event, "text")).toBe(allowed);
    expect(write).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("reports native write errors as failures", () => {
    const { target } = setup();
    expect(
      createClipboardHandler(
        () => target,
        () => {
          throw new Error("unavailable");
        },
      )(event, "text"),
    ).toBe(false);
  });
});
