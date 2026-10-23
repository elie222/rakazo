// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotContextCards } from "../components/bot-context-cards";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/profile-edit-dialog", () => ({ ProfileEditDialog: () => null }));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Alert: { alert: vi.fn() }, Pressable: view, Text: view, View: view };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.mockReset();
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
});
