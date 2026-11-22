// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import * as Clipboard from "expo-clipboard";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMessage } from "../api/mobile-types";

const native = vi.hoisted(() => ({
  back: null as null | (() => boolean),
  removed: vi.fn(),
  dismiss: vi.fn(),
  success: vi.fn(),
}));

vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_: string, handler: () => boolean) => {
      native.back = handler;
      return {
        remove: () => {
          native.back = null;
          native.removed();
        },
      };
    },
  },
  Keyboard: { dismiss: native.dismiss },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../native/haptics", () => ({ hapticSuccess: native.success }));

import { useThreadSelection } from "./thread-selection";

type Selection = ReturnType<typeof useThreadSelection>;
type Props = { threadKey: string | undefined; focused: boolean; messages: MobileMessage[] };

let root: Root;
let latest: Selection;

function Probe(props: Props) {
  latest = useThreadSelection(props);
  return null;
}

const render = (props: Props) => act(() => root.render(createElement(Probe, props)));

const message = (id: string, body: string) =>
  ({ id, role: "bot", blocks: [{ kind: "text", text: body }] }) as MobileMessage;
const messages = [message("a", "one"), message("b", "two"), message("c", "three")];
const base: Props = { threadKey: "bot-1", focused: true, messages };
const setString = vi.mocked(Clipboard.setStringAsync);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.back = null;
  native.removed.mockReset();
  native.dismiss.mockReset();
  native.success.mockReset();
  setString.mockReset();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("copies the chosen messages together in chat order, then leaves selection mode", async () => {
  setString.mockResolvedValue(true);
  await render(base);
  expect(latest.ids).toBeNull();

  act(() => latest.start(messages[2]!));
  act(() => latest.toggle(messages[0]!));
  expect(latest.count).toBe(2);
  expect(native.dismiss).toHaveBeenCalled();

  await act(async () => latest.copy());
  expect(setString).toHaveBeenCalledWith("one\n\nthree");
  expect(native.success).toHaveBeenCalledTimes(1);
  expect(latest.ids).toBeNull();
});

it("stays in selection mode when the clipboard write fails, so the person can try again", async () => {
  const denied = new Error("denied");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setString.mockRejectedValueOnce(denied);
  await render(base);
  act(() => latest.start(messages[0]!));

  await act(async () => latest.copy());
  expect(native.success).not.toHaveBeenCalled();
  expect(latest.ids).not.toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("Clipboard write failed", denied);
  warn.mockRestore();

  setString.mockResolvedValueOnce(true);
  await act(async () => latest.copy());
  expect(setString).toHaveBeenLastCalledWith("one");
  expect(latest.ids).toBeNull();
});

it("treats a clipboard that answers false as not copied", async () => {
  setString.mockResolvedValueOnce(false);
  await render(base);
  act(() => latest.start(messages[0]!));
  await act(async () => latest.copy());
  expect(native.success).not.toHaveBeenCalled();
  expect(latest.ids).not.toBeNull();
});

it("adds to the chosen messages when selection starts again, as an accessibility action can", async () => {
  await render(base);
  act(() => latest.start(messages[0]!));
  act(() => latest.start(messages[1]!));
  expect(latest.ids ? [...latest.ids] : null).toEqual(["a", "b"]);
});

it("does not clear the selection if the copy finishes after the person cancelled", async () => {
  const write = deferred<boolean>();
  setString.mockReturnValue(write.promise);
  await render(base);
  act(() => latest.start(messages[0]!));
  const copying = act(async () => {
    void latest.copy();
  });
  await copying;
  act(() => latest.cancel());
  act(() => latest.start(messages[1]!));
  await act(async () => write.resolve(true));
  expect(latest.ids ? [...latest.ids] : null).toEqual(["b"]);
});

it("does not start on a message with nothing to copy", async () => {
  await render({ ...base, messages: [...messages, message("p", "  ")] });
  act(() => latest.start(message("progress:1", "working")));
  act(() => latest.start(message("p", "  ")));
  expect(latest.ids).toBeNull();
});

it("counts only chosen messages that are still in the chat", async () => {
  await render(base);
  act(() => latest.start(messages[0]!));
  act(() => latest.toggle(messages[1]!));
  expect(latest.count).toBe(2);
  await render({ ...base, messages: [messages[1]!, messages[2]!] });
  expect(latest.count).toBe(1);
  setString.mockResolvedValue(true);
  await act(async () => latest.copy());
  expect(setString).toHaveBeenCalledWith("two");
});

it("does not copy an empty selection", async () => {
  await render(base);
  act(() => latest.start(messages[0]!));
  await render({ ...base, messages: [] });
  expect(latest.count).toBe(0);
  await act(async () => latest.copy());
  expect(setString).not.toHaveBeenCalled();
  expect(latest.ids).not.toBeNull();
});

it("leaves selection mode when the chat changes", async () => {
  await render(base);
  act(() => latest.start(messages[0]!));
  await render({ ...base, threadKey: "bot-2" });
  expect(latest.ids).toBeNull();
  await render(base);
  expect(latest.ids).toBeNull();
});

it("answers Back while selecting, only in the focused chat, and lets go afterwards", async () => {
  await render(base);
  expect(native.back).toBeNull();
  act(() => latest.start(messages[0]!));
  expect(native.back).not.toBeNull();

  await render({ ...base, focused: false });
  expect(native.back).toBeNull();
  await render(base);

  let handled = false;
  act(() => {
    handled = native.back?.() ?? false;
  });
  expect(handled).toBe(true);
  expect(latest.ids).toBeNull();
  expect(native.back).toBeNull();
});
