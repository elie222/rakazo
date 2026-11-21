// @vitest-environment jsdom

import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/api/api";
import { queryClient } from "../../lib/query/query";
import { SharedRepliesGroup } from "./shared-replies";

vi.mock("../../lib/api/api", () => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  subscribeSpaceSelection: () => () => undefined,
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 0,
    headers: {},
  }),
}));
vi.mock("../../lib/api/session", () => ({
  currentSessionGeneration: () => 0,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("../../lib/api/user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("../../lib/platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../../lib/i18n/i18n", () => ({ useUiLocale: () => "en-US" }));
vi.mock("../../lib/native/native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) =>
    useEffect(() => effect() ?? undefined, [effect]),
}));
vi.mock("./settings-group", () => ({
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingsRow: ({ title, detail, value }: { title: string; detail?: string; value?: string }) => (
    <div data-row={title}>
      {title} | {detail} | {value}
    </div>
  ),
}));
// The menu's actions show as buttons after the row they act on.
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.attributes?.disabled}
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

const share = (id: string, botName: string, preview: string) => ({
  id,
  botName,
  preview,
  createdAt: "2026-11-02T10:00:00.000Z",
});

let shares: ReturnType<typeof share>[];
let container: HTMLDivElement;
let root: Root;

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  shares = [share("s1", "Scout", "The answer is 42."), share("s2", "Ada", "Hello")];
  vi.mocked(rpc).mockImplementation(async (path: string, body?: unknown) => {
    if (path === "replyShares/list") return shares as never;
    if (path === "replyShares/remove") {
      const { shareId } = body as { shareId: string };
      shares = shares.filter((item) => item.id !== shareId);
      return { ok: true } as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const rows = () => [...container.querySelectorAll("[data-row]")].map((row) => row.textContent);

it("lists every shared reply with its bot, first words and date, and removes one", async () => {
  await act(async () => root.render(<SharedRepliesGroup />));
  await vi.waitFor(() =>
    expect(rows()).toEqual([
      "Scout | The answer is 42. | Nov 2, 2026",
      "Ada | Hello | Nov 2, 2026",
    ]),
  );
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Shared links");

  const removes = [...container.querySelectorAll("button")];
  expect(removes.map((button) => button.textContent)).toEqual(["Remove", "Remove"]);
  await act(async () => removes[1]?.click());
  expect(rpc).toHaveBeenCalledWith("replyShares/remove", { shareId: "s2" }, expect.anything());
  await vi.waitFor(() => expect(rows()).toEqual(["Scout | The answer is 42. | Nov 2, 2026"]));
});

it("says when a link could not be removed", async () => {
  await act(async () => root.render(<SharedRepliesGroup />));
  await vi.waitFor(() => expect(rows()).toHaveLength(2));
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  await act(async () => container.querySelector("button")?.click());
  await vi.waitFor(() =>
    expect(Alert.alert).toHaveBeenCalledWith("Could not continue", "Try again."),
  );
  expect(rows()).toHaveLength(2);
});

it("shows nothing while no reply is shared", async () => {
  shares = [];
  await act(async () => root.render(<SharedRepliesGroup />));
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("replyShares/list", undefined, expect.anything()),
  );
  expect(container.innerHTML).toBe("");
});
