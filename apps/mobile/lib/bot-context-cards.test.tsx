// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotContextCards } from "../components/bot-context-cards";

const { rpc, push, focus } = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  focus: { current: null as null | (() => (() => void) | undefined) },
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push }),
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    focus.current = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.mockReset();
  push.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const work = [{ id: "work-a", title: "Review draft", notes: "", status: "open" }];
const memory = [{ id: "memory-a", path: "notes.md", content: "Saved context" }];

async function render(botId = "bot-a") {
  await act(async () => root.render(createElement(BotContextCards, { botId })));
}

describe("bot context cards", () => {
  it.each([
    ["scratchpad/list", "Memory", "notes.md", "Open work"],
    ["memory/list", "Open work", "Review draft", "Memory"],
  ])("renders the other section when %s fails", async (failed, heading, item, hidden) => {
    rpc.mockImplementation(async (method: string) => {
      if (method === failed) throw new Error("Request failed");
      return method === "scratchpad/list" ? work : memory;
    });
    await render();
    expect(container.textContent).toContain(heading);
    expect(container.textContent).toContain(item);
    expect(container.textContent).not.toContain(hidden);
    expect(container.textContent).toContain("Request failed");
  });

  it.each([
    ["scratchpad/list", "Memory", "notes.md"],
    ["memory/list", "Open work", "Review draft"],
  ])("renders the other section while %s is still pending", async (pending, heading, item) => {
    rpc.mockImplementation((method: string) => {
      if (method === pending) return new Promise(() => {});
      return Promise.resolve(method === "scratchpad/list" ? work : memory);
    });
    await render();
    expect(container.textContent).toContain(heading);
    expect(container.textContent).toContain(item);
  });

  it("hides empty work and placeholder-only memory", async () => {
    rpc.mockImplementation(async (method: string) =>
      method === "scratchpad/list" ? [] : [{ id: "memory-a", path: "MEMORY.md", content: "" }],
    );
    await render();
    expect(container.textContent).toBe("");
  });

  it("ignores results from the previous bot", async () => {
    let resolveWork!: (items: typeof work) => void;
    rpc.mockImplementation((method: string, { botId }: { botId: string }) => {
      if (botId === "bot-a" && method === "scratchpad/list") {
        return new Promise((resolve) => {
          resolveWork = resolve;
        });
      }
      return Promise.resolve([]);
    });
    await render();
    await render("bot-b");
    await act(async () => resolveWork(work));
    expect(container.textContent).toBe("");
  });

  it("opens a remembered note in its editor", async () => {
    rpc.mockImplementation(async (method: string) => (method === "scratchpad/list" ? [] : memory));
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="notes.md"]')?.click(),
    );
    expect(push).toHaveBeenCalledWith({
      pathname: "/memory-note",
      params: { id: "memory-a", botId: "bot-a" },
    });
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
      focus.current!();
    });
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Retained draft");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === (action === "save" ? "Save" : "Cancel"))!
        .click(),
    );
    expect(container.querySelector("input")).toBeNull();
    if (action === "save") {
      expect(rpc).toHaveBeenCalledWith("scratchpad/create", {
        botId: "bot-a",
        title: "Retained draft",
      });
      expect(container.textContent).toContain("Retained draft");
    } else {
      expect(rpc.mock.calls.filter(([method]) => method === "scratchpad/create")).toHaveLength(0);
      expect(container.textContent).not.toContain("Open work");
    }
  },
);
