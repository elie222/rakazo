// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMessage } from "../api/mobile-types";

type Button = { text: string; onPress?: () => void };
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  copy: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("expo-clipboard", () => ({ setStringAsync: state.copy }));
vi.mock("../api/api", () => ({ rpc: state.rpc }));
vi.mock("../api/user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../query/query", () => ({
  accountRpcQuery: (path: string) => ({ queryKey: ["account", path] }),
  queryClient: { invalidateQueries: state.invalidate },
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  useSave: (options: any) => ({
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    run: (input: any) => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const send = (proc: string, body: any) => state.rpc(proc, body);
      void (async () => {
        try {
          const saved = await options.save(input, send);
          await Promise.all(
            (options.stale ?? []).map((queryKey: unknown) => state.invalidate({ queryKey })),
          );
          await options.onSaved?.(saved, input);
        } catch (cause) {
          options.onFailed?.(cause, input);
        }
      })();
    },
    pending: false,
  }),
}));

import { useReplyShare } from "./reply-share";

const CANARY = "CANARY-HIDDEN-7f3a";
const reply = {
  id: "message-1",
  role: "bot",
  blocks: [
    { kind: "text", text: "Mail owner@example.com today." },
    { kind: "card", lines: [{ k: "key", v: CANARY }] },
  ],
} as MobileMessage;

let root: Root;
let share: ReturnType<typeof useReplyShare>;

function Probe({ target }: { target?: { botId: string } }) {
  share = useReplyShare(target);
  return null;
}

/** The buttons of the alert shown last. */
function lastButtons(): Button[] {
  return (state.alert.mock.calls.at(-1)?.[2] ?? []) as Button[];
}

async function pressCopyLink() {
  const copyLink = lastButtons().find((button) => button.text === "Copy link");
  if (!copyLink?.onPress) throw new Error("Missing Copy link");
  await act(async () => copyLink.onPress?.());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe, { target: { botId: "bot-1" } })));
});

afterEach(() => {
  act(() => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("shows the redacted reply text and makes the link only when Copy link is pressed", async () => {
  state.rpc.mockResolvedValue({ shareUrl: "https://app.test/c/token" });
  state.copy.mockResolvedValue(true);
  act(() => share(reply));

  const [title, text] = state.alert.mock.calls[0] ?? [];
  expect(title).toBe("Anyone with the link can read this reply");
  expect(text).toBe("Mail [Redacted] today.");
  expect(text).not.toContain(CANARY);
  expect(lastButtons().map((button) => button.text)).toEqual(["Cancel", "Copy link"]);
  expect(state.rpc).not.toHaveBeenCalled();

  await pressCopyLink();
  expect(state.rpc).toHaveBeenCalledWith("replyShares/create", {
    botId: "bot-1",
    messageId: "message-1",
  });
  expect(state.invalidate).toHaveBeenCalledWith({
    queryKey: ["account", "replyShares/list"],
  });
  expect(state.copy).toHaveBeenCalledWith("https://app.test/c/token");
  expect(state.alert).toHaveBeenLastCalledWith("Link copied");
});

it("shows the link to copy by hand when copying fails", async () => {
  state.rpc.mockResolvedValue({ shareUrl: "https://app.test/c/token" });
  state.copy.mockRejectedValue(new Error("denied"));
  act(() => share(reply));
  await pressCopyLink();
  expect(state.alert).toHaveBeenLastCalledWith(
    "Could not copy the link.",
    "https://app.test/c/token",
  );
});

it("says when the link could not be made, and copies nothing", async () => {
  state.rpc.mockRejectedValue(new Error("offline"));
  act(() => share(reply));
  await pressCopyLink();
  expect(state.alert).toHaveBeenLastCalledWith("Could not continue", "Try again.");
  expect(state.copy).not.toHaveBeenCalled();
  expect(state.invalidate).not.toHaveBeenCalled();
});

it("offers nothing outside a chat", () => {
  act(() => root.render(createElement(Probe, {})));
  act(() => share(reply));
  expect(state.alert).not.toHaveBeenCalled();
});
