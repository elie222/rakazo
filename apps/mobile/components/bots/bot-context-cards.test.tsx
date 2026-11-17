// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, rpcQuery } from "../../lib/query/query";
import { BotContextCards } from "./bot-context-cards";

const { rpc, push, focus } = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  focus: { effects: new Set<() => (() => void) | undefined>() },
}));
vi.mock("../../lib/api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push }),
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    useEffect(() => {
      focus.effects.add(effect);
      const cleanup = effect();
      return () => {
        focus.effects.delete(effect);
        cleanup?.();
      };
    }, [effect]);
  },
}));
vi.mock("../../lib/native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../../lib/api/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../settings/settings-group", () => ({
  SettingsGroup: ({ label, children }: { label: string; children?: ReactNode }) =>
    createElement("section", null, label, children),
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement("button", { type: "button", "aria-label": title, onClick: onPress }, title),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const Pressable = ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": accessibilityLabel, onClick: onPress },
      children,
    );
  return {
    Pressable,
    Text: view,
    View: view,
    Platform: { OS: "android" },
    Alert: {},
    Modal: view,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel: string;
    }) =>
      createElement("input", {
        value,
        "aria-label": accessibilityLabel,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
  };
});

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.mockReset();
  push.mockReset();
  queryClient.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const work = [{ id: "work-a", title: "Review draft", notes: "", status: "open" }];
const memory = [{ id: "memory-a", path: "notes.md", content: "Saved context" }];

async function render(botId = "bot-a", section: "work" | "memory" = "work") {
  await act(async () => root.render(createElement(BotContextCards, { botId, section })));
}

describe("bot context cards", () => {
  it.each([
    ["work", "scratchpad/list", "Open work", "Review draft", "Memory"],
    ["memory", "memory/list", "Memory", "notes.md", "Open work"],
  ] as const)("loads only the %s list", async (section, method, heading, item, other) => {
    rpc.mockImplementation(async (called: string) =>
      called === "scratchpad/list" ? work : memory,
    );
    await render("bot-a", section);
    expect(rpc.mock.calls.map(([called]) => called)).toEqual([method]);
    expect(container.textContent).toContain(heading);
    expect(container.textContent).toContain(item);
    expect(container.textContent).not.toContain(other);
  });

  it.each(["work", "memory"] as const)("shows a failed %s load", async (section) => {
    rpc.mockRejectedValue(new Error("Request failed"));
    await render("bot-a", section);
    expect(container.textContent).toBe("Request failed");
  });

  it("hides empty work and placeholder-only memory", async () => {
    rpc.mockImplementation(async (method: string) =>
      method === "scratchpad/list" ? [] : [{ id: "memory-a", path: "MEMORY.md", content: "" }],
    );
    await render("bot-a", "work");
    expect(container.textContent).toBe("");
    await render("bot-a", "memory");
    expect(container.textContent).toBe("");
  });

  it("ignores results from the previous bot", async () => {
    let resolveWork!: Deferred<typeof work>;
    rpc.mockImplementation((method: string, { botId }: { botId: string }) => {
      if (botId === "bot-a" && method === "scratchpad/list") {
        resolveWork = deferred<typeof work>();
        return resolveWork.promise;
      }
      return Promise.resolve([]);
    });
    await render();
    await render("bot-b");
    await act(async () => resolveWork.resolve(work));
    expect(container.textContent).toBe("");
  });

  it("opens a remembered note in its editor", async () => {
    rpc.mockImplementation(async (method: string) => (method === "scratchpad/list" ? [] : memory));
    await render("bot-a", "memory");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="notes.md"]')?.click(),
    );
    expect(push).toHaveBeenCalledWith({
      pathname: "/memory-note",
      params: { id: "memory-a", botId: "bot-a" },
    });
  });

  it("completes an item once on a double tap and drops it, or shows why it could not", async () => {
    const done = deferred<unknown>();
    rpc.mockImplementation((method: string) =>
      method === "scratchpad/update" ? done.promise : Promise.resolve(work),
    );
    await render();
    const complete = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Complete Review draft"]')!.click();
    await act(async () => {
      complete();
      complete();
    });
    const updates = rpc.mock.calls.filter(([method]) => method === "scratchpad/update");
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toEqual({ itemId: "work-a", status: "done" });
    await act(async () => done.resolve({}));
    expect(container.textContent).not.toContain("Review draft");

    queryClient.clear();
    rpc.mockImplementation(async (method: string) => {
      if (method === "scratchpad/update") throw new Error("Already done");
      return work;
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => complete());
    expect(container.textContent).toContain("Already done");
    expect(container.textContent).toContain("Review draft");
  });

  it("keeps a saved item when a read started before the save answers after it", async () => {
    const staleRead = deferred<typeof work>();
    let reads = 0;
    rpc.mockImplementation((method: string) => {
      if (method === "scratchpad/list")
        return reads++ === 0 ? Promise.resolve(work) : staleRead.promise;
      return Promise.resolve({});
    });
    await render();
    await act(async () => {
      void queryClient.refetchQueries({
        queryKey: rpcQuery("scratchpad/list", { botId: "bot-a" }).queryKey,
      });
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Complete Review draft"]')!.click(),
    );
    await act(async () => staleRead.resolve(work));
    expect(container.textContent).not.toContain("Review draft");
  });

  it("clears a failed complete when the screen is shown again", async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === "scratchpad/update") throw new Error("Already done");
      return work;
    });
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Complete Review draft"]')!.click(),
    );
    expect(container.textContent).toContain("Already done");
    await act(async () => {
      for (const effect of focus.effects) effect();
    });
    expect(container.textContent).not.toContain("Already done");
    expect(container.textContent).toContain("Review draft");
  });

  it("clears an earlier load error once the lists load", async () => {
    rpc.mockImplementation(async (method: string, { botId }: { botId: string }) => {
      if (botId === "bot-a" && method === "scratchpad/list") throw new Error("Request failed");
      return method === "scratchpad/list" ? work : memory;
    });
    await render();
    expect(container.textContent).toContain("Request failed");
    await render("bot-b");
    expect(container.textContent).not.toContain("Request failed");
    expect(container.textContent).toContain("Review draft");
  });
});

it.each(["save", "cancel"])(
  "preserves an Android draft when a focused refresh empties the list, then %s",
  async (action) => {
    let reads = 0;
    rpc.mockImplementation(async (method: string) => {
      if (method === "scratchpad/list") return reads++ === 0 ? work : [];
      if (method === "scratchpad/create") return { ...work[0], id: "new", title: "Retained draft" };
      return [];
    });
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Retained draft",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      for (const effect of focus.effects) effect();
    });
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Retained draft");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === (action === "save" ? "Save" : "Cancel"))!
        .click(),
    );
    expect(container.querySelector("input")).toBeNull();
    if (action === "save") {
      expect(rpc).toHaveBeenCalledWith(
        "scratchpad/create",
        { botId: "bot-a", title: "Retained draft" },
        expect.anything(),
      );
      expect(container.textContent).toContain("Retained draft");
    } else {
      expect(rpc.mock.calls.filter(([method]) => method === "scratchpad/create")).toHaveLength(0);
      expect(container.textContent).not.toContain("Open work");
    }
  },
);
