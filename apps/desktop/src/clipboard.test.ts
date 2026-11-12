import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createClipboardHandler } from "./clipboard.js";

function setup() {
  const frame = { url: "https://app.example.com/app/bot" };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const target = { webContents: contents, url: "https://app.example.com" };
  const write = vi.fn();
  return { event, target, write, handle: createClipboardHandler(() => target, write) };
}

describe("desktop clipboard handler", () => {
  it("writes strings, including empty text, only from the app page", () => {
    const { event, write, handle } = setup();
    expect(handle(event, "code\ntext")).toBe(true);
    expect(handle(event, "")).toBe(true);
    expect(write.mock.calls).toEqual([["code\ntext"], [""]]);
  });

  it("rejects other windows, same-origin subframes, missing frames and navigated pages", () => {
    const { event, target, write, handle } = setup();
    expect(handle({ ...event, sender: {} as WebContents }, "text")).toBe(false);
    expect(handle({ ...event, senderFrame: null }, "text")).toBe(false);
    expect(
      handle(
        { ...event, senderFrame: { url: target.url } as IpcMainInvokeEvent["senderFrame"] },
        "text",
      ),
    ).toBe(false);
    for (const url of [
      "https://other.example.com",
      "invalid",
      "data:text/html,test",
      "file:///test",
    ]) {
      Object.assign(event.senderFrame!, { url });
      expect(handle(event, "text")).toBe(false);
    }
    Object.assign(event.senderFrame!, { url: target.url });
    target.webContents.isDestroyed = () => true;
    expect(handle(event, "text")).toBe(false);
    expect(createClipboardHandler(() => null, write)(event, "text")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 42, {}, ["text"], true])("rejects non-string payload %s", (text) => {
    const { event, handle, write } = setup();
    expect(handle(event, text)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("reports native write errors as failures", () => {
    const { event, target } = setup();
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
