// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMessage } from "./api";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  focused: true,
}));

vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => state.focused }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  AppState: { currentState: "active" },
}));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./live-notifications", () => ({ dismissThreadNotifications: vi.fn(async () => {}) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

import { useThreadRead } from "./thread-read";

type ThreadRead = ReturnType<typeof useThreadRead>;
type Props = { botId?: string; groupId?: string; focused: boolean };

let root: Root;
let latest: ThreadRead;

function Probe(props: Props) {
  latest = useThreadRead({ ...props, readOnly: false });
  return null;
}

const render = (props: Props) => act(() => root.render(createElement(Probe, props)));
const flush = () => act(async () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const message = { id: "message-1" } as MobileMessage;
const calls = (method: string) => state.rpc.mock.calls.filter(([name]) => name === method).length;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockReset();
  state.alert.mockReset();
  state.focused = true;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("starts a fresh read visit when a retained thread regains focus", async () => {
  state.rpc.mockResolvedValue({ unreadAfterSeq: 3 });
  render({ botId: "bot-1", focused: true });
  const initialVisit = latest.readVisit.current.visit;
  act(() => latest.markReadIfVisible());
  await flush();
  expect(latest.readBoundary).toEqual({ visit: initialVisit, seq: 3 });
  expect(latest.readVisibleTarget.current).toBe("bot-1");

  // Re-rendering while focused, or blurring, keeps the visit.
  render({ botId: "bot-1", focused: true });
  expect(latest.readVisit.current.visit).toBe(initialVisit);
  render({ botId: "bot-1", focused: false });
  expect(latest.readVisit.current.visit).toBe(initialVisit);

  // Regaining focus is a new visit: the chat is read again and the divider follows that answer.
  render({ botId: "bot-1", focused: true });
  const returnedVisit = latest.readVisit.current.visit;
  expect(returnedVisit).toBe(initialVisit + 1);
  expect(latest.readVisibleTarget.current).toBeNull();
  state.rpc.mockResolvedValue({ unreadAfterSeq: null });
  act(() => latest.markReadIfVisible());
  await flush();
  expect(calls("threads/markRead")).toBe(2);
  expect(latest.readBoundary).toEqual({ visit: returnedVisit, seq: null });

  // Opening another chat is also a new visit.
  render({ botId: "bot-2", focused: true });
  expect(latest.readVisit.current.visit).toBe(returnedVisit + 1);
});

it("holds a chat marked unread from a message for that visit only", async () => {
  state.rpc.mockResolvedValue({});
  render({ botId: "bot-1", focused: true });
  act(() => latest.markUnreadFrom(message));
  await flush();
  expect(state.rpc).toHaveBeenCalledWith("threads/markUnread", {
    botId: "bot-1",
    messageId: "message-1",
  });
  expect(latest.markedUnreadMessageId).toBe("message-1");

  act(() => latest.markReadIfVisible());
  await flush();
  expect(calls("threads/markRead")).toBe(0);

  // Coming back to the chat is a new visit, so it is read again.
  render({ botId: "bot-1", focused: false });
  render({ botId: "bot-1", focused: true });
  expect(latest.markedUnreadMessageId).toBeUndefined();
  act(() => latest.markReadIfVisible());
  await flush();
  expect(calls("threads/markRead")).toBe(1);
});

it("sends the unread write through the chat's read queue and skips queued reads while held", async () => {
  const firstRead = deferred<{ unreadAfterSeq: number }>();
  state.rpc.mockImplementation((method: string) =>
    method === "threads/markRead" && calls("threads/markRead") === 1
      ? firstRead.promise
      : Promise.resolve({}),
  );
  render({ groupId: "group-1", focused: true });
  act(() => latest.markReadIfVisible());
  await flush();
  expect(calls("threads/markRead")).toBe(1);

  // A new visit queues another read behind the first, then the user marks the chat unread.
  render({ groupId: "group-1", focused: false });
  render({ groupId: "group-1", focused: true });
  act(() => latest.markReadIfVisible());
  act(() => latest.markUnreadFrom(message));
  await flush();
  expect(calls("threads/markUnread")).toBe(0);

  firstRead.resolve({ unreadAfterSeq: 4 });
  await flush();
  // The queued read saw the hold and skipped; the unread write ran after the first read.
  expect(state.rpc.mock.calls.map(([method]) => method)).toEqual([
    "threads/markRead",
    "threads/markUnread",
  ]);
  expect(state.rpc).toHaveBeenLastCalledWith("threads/markUnread", {
    groupId: "group-1",
    messageId: "message-1",
  });
});

it("releases the hold and alerts when marking unread fails", async () => {
  state.rpc.mockImplementation((method: string) =>
    method === "threads/markUnread" ? Promise.reject(new Error("offline")) : Promise.resolve({}),
  );
  render({ botId: "bot-1", focused: true });
  act(() => latest.markUnreadFrom(message));
  await flush();
  expect(state.alert).toHaveBeenCalledWith("Could not update chat", "Try again.");
  act(() => latest.markReadIfVisible());
  await flush();
  expect(calls("threads/markRead")).toBe(1);
});
