import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createSystemSpeech, SPEECH_EVENT_CHANNEL } from "./system-speech.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    kill: vi.fn(),
  });
}

type FakeChild = ReturnType<typeof fakeChild>;

function setup() {
  const frame = { url: "https://app.example.com/app/bot" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const event = {
    sender: contents as unknown as WebContents,
    senderFrame: frame,
  } as IpcMainInvokeEvent;
  const target = {
    webContents: contents as unknown as WebContents,
    url: "https://app.example.com",
  };
  const children: FakeChild[] = [];
  const spawn = vi.fn((_language: string) => {
    const child = fakeChild();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const speech = createSystemSpeech(() => target, spawn);
  const sent = () =>
    contents.send.mock.calls
      .filter(([channel]) => channel === SPEECH_EVENT_CHANNEL)
      .map(([, message]) => message);
  return { contents, event, frame, speech, spawn, children, sent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("desktop system speech", () => {
  it("forwards the recognizer's results, known errors and end for the page's session", async () => {
    const { event, speech, spawn, children, sent } = setup();
    expect(speech.start(event, "es-CL", 7)).toBe(true);
    expect(spawn).toHaveBeenCalledWith("es-CL");
    const child = children[0]!;

    child.stdout.write('{"type":"result","text":"hola"}\n{"type":"res');
    child.stdout.write('ult","text":"hola mundo"}\nnot json\n[]\n');
    child.stdout.write('{"type":"error","error":"rm -rf"}\n{"type":"error","error":"no-speech"}\n');
    child.stdout.write('{"type":"end"}\n');
    await flush();
    child.emit("close", 0);

    expect(sent()).toEqual([
      { session: 7, type: "result", text: "hola" },
      { session: 7, type: "result", text: "hola mundo" },
      { session: 7, type: "error", error: "no-speech" },
      { session: 7, type: "end" },
    ]);
  });

  it("refuses other windows, subframes, other origins, odd languages and sessions", () => {
    const { event, frame, speech, spawn } = setup();
    expect(speech.start({ ...event, sender: {} as WebContents }, "en-US", 1)).toBe(false);
    expect(speech.start({ ...event, senderFrame: null }, "en-US", 1)).toBe(false);
    expect(
      speech.start({ ...event, senderFrame: { ...frame } } as IpcMainInvokeEvent, "en-US", 1),
    ).toBe(false);
    for (const language of [
      "",
      "e",
      "en US",
      "--help",
      "en-US;rm",
      "en-US\n",
      "en_US",
      `en-${"a".repeat(100)}`,
      42,
      null,
    ]) {
      expect(speech.start(event, language, 1)).toBe(false);
    }
    for (const session of [0, -1, 1.5, Number.NaN, "1", null]) {
      expect(speech.start(event, "en-US", session)).toBe(false);
    }
    Object.assign(frame, { url: "https://other.example.com" });
    expect(speech.start(event, "en-US", 1)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ends a session whose recognizer cannot launch exactly once, as a refused service", async () => {
    const { event, speech, children, sent } = setup();
    speech.start(event, "en-US", 3);
    children[0]!.emit("error", new Error("spawn ENOENT"));
    children[0]!.emit("close", null);
    expect(sent()).toEqual([
      { session: 3, type: "error", error: "service-not-allowed" },
      { session: 3, type: "end" },
    ]);
  });

  it("reports a spawn that throws only after the page has its session", async () => {
    const { contents, event, sent } = setup();
    const speech = createSystemSpeech(
      () => ({ webContents: contents as unknown as WebContents, url: "https://app.example.com" }),
      () => {
        throw new Error("EACCES");
      },
    );
    expect(speech.start(event, "en-US", 4)).toBe(true);
    expect(sent()).toEqual([]);
    await flush();
    expect(sent()).toEqual([
      { session: 4, type: "error", error: "service-not-allowed" },
      { session: 4, type: "end" },
    ]);
  });

  it("stops and aborts only the session the page owns", () => {
    const { event, speech, children } = setup();
    speech.start(event, "en-US", 1);
    const child = children[0]!;
    speech.stop(event, 2);
    speech.abort(event, 2);
    speech.stop({ ...event, senderFrame: null }, 1);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    speech.stop(event, 1);
    expect(child.stdin.write).toHaveBeenCalledWith("stop\n");
    speech.abort(event, 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    speech.stop(event, 1);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("runs one recognizer at a time and stops it with the window", () => {
    const { contents, event, speech, children } = setup();
    speech.start(event, "en-US", 1);
    speech.start(event, "en-US", 2);
    speech.start(event, "en-US", 3);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(children[1]!.kill).toHaveBeenCalledTimes(1);
    expect(children[2]!.kill).not.toHaveBeenCalled();
    expect(contents.listenerCount("destroyed")).toBe(1);

    contents.emit("destroyed");
    expect(children[2]!.kill).toHaveBeenCalledTimes(1);
  });

  it("stops on main-frame navigation and ignores late output", () => {
    const { contents, event, speech, children, sent } = setup();
    speech.start(event, "en-US", 1);
    contents.emit("did-start-navigation", {}, "https://app.example.com/next", false, false);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    contents.emit("did-start-navigation", {}, "https://app.example.com/next", false, true);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.stdout.write('{"type":"result","text":"late"}\n');
    children[0]!.emit("close");
    expect(sent()).toEqual([]);
  });

  it.each(["", "\n"])("rejects oversized output lines (%j)", async (ending) => {
    const { event, speech, children, sent } = setup();
    speech.start(event, "en-US", 5);
    children[0]!.stdout.write("x".repeat(64 * 1024 + 1) + ending);
    await flush();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([
      { session: 5, type: "error", error: "network" },
      { session: 5, type: "end" },
    ]);
  });
});
