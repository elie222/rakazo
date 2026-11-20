// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerModelKeys } from "./composer-model-picker";

vi.mock("../../../lib/query/rpc", () => {
  const rpc = {
    bots: { update: vi.fn(), list: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => [{ provider: "acme", label: "Acme" }]),
      list: vi.fn(async () => [
        { provider: "acme", id: "fast", label: "Fast", thinkingLevels: ["low", "high"] },
        { provider: "acme", id: "smart", label: "Smart" },
        { provider: "acme", id: "steady", label: "Steady", thinkingLevels: ["medium"] },
        { provider: "acme", id: "deep", label: "Deep", thinkingLevels: ["low", "medium", "high"] },
      ]),
    },
    me: vi.fn(async () => ({ defaultProvider: "acme", defaultModel: "fast" })),
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const { rpc } = await import("../../../lib/query/rpc");
const { ComposerModelPicker } = await import("./composer-model-picker");

const bot = {
  id: "bot-1",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
} as unknown as Bot;

describe("ComposerModelPicker", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("names the Space default's model and saves a pick to the bot", async () => {
    const onSaved = vi.fn();
    const updated = { ...bot, modelProvider: "acme", modelId: "smart" };
    vi.mocked(rpc.bots.update).mockResolvedValue(updated as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker bot={bot} onSaved={onSaved} onConnect={vi.fn()} />
        </QueryClientProvider>,
      ),
    );

    const trigger = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]');
      if (!button) throw new Error("not rendered yet");
      return button;
    });
    expect(trigger.textContent).toContain("Fast");
    // The Space default's model offers thinking levels, so its default level shows too.
    expect(trigger.textContent).toContain("Medium");

    act(() => trigger.click());
    const smart = await vi.waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
        row.textContent?.includes("Smart"),
      );
      if (!option) throw new Error("list not open");
      return option;
    });
    act(() => smart.click());

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated, "acme::smart"));
    expect(rpc.bots.update).toHaveBeenCalledWith({
      botId: "bot-1",
      modelProvider: "acme",
      modelId: "smart",
      thinkingLevel: null,
    });
  });

  it("opens when its owner asks, as the keyboard shortcut does, and reports closing", async () => {
    const onOpenChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker
            bot={bot}
            onSaved={vi.fn()}
            onConnect={vi.fn()}
            open
            onOpenChange={onOpenChange}
          />
        </QueryClientProvider>,
      ),
    );
    const option = await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[role="option"]');
      if (!row) throw new Error("list not open");
      return row;
    });
    act(() => {
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("steps to the next thinking level from the keyboard, wrapping at the end", async () => {
    const registered: { keys: ComposerModelKeys | null } = { keys: null };
    const register = (next: ComposerModelKeys | null) => {
      registered.keys = next;
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = (current: Bot) =>
      act(() =>
        root.render(
          <QueryClientProvider client={client}>
            <ComposerModelPicker
              bot={current}
              onSaved={vi.fn()}
              onConnect={vi.fn()}
              onKeysChange={register}
            />
          </QueryClientProvider>,
        ),
      );
    vi.mocked(rpc.bots.update).mockResolvedValue({ ...bot, thinkingLevel: "low" } as never);
    render({ ...bot, thinkingLevel: "high" } as Bot);
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label^="Model"]')).not.toBeNull(),
    );

    let stepped: boolean | undefined;
    act(() => {
      stepped = registered.keys?.stepThinking();
    });
    expect(stepped).toBe(true);
    await vi.waitFor(() =>
      expect(rpc.bots.update).toHaveBeenLastCalledWith({ botId: "bot-1", thinkingLevel: "low" }),
    );
  });

  it("offers no thinking step for a model without levels", async () => {
    const registered: { keys: ComposerModelKeys | null } = { keys: null };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker
            bot={{ ...bot, modelProvider: "acme", modelId: "smart" } as Bot}
            onSaved={vi.fn()}
            onConnect={vi.fn()}
            onKeysChange={(next) => {
              registered.keys = next;
            }}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label^="Model"]')).not.toBeNull(),
    );
    vi.mocked(rpc.bots.update).mockClear();
    expect(registered.keys?.stepThinking()).toBe(false);
    expect(rpc.bots.update).not.toHaveBeenCalled();
  });

  it("saves Default when a step lands on the default's level, so the bot keeps following it", async () => {
    const registered: { keys: ComposerModelKeys | null } = { keys: null };
    vi.mocked(rpc.bots.update).mockResolvedValue({ ...bot, thinkingLevel: null } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker
            bot={{ ...bot, modelProvider: "acme", modelId: "deep", thinkingLevel: "low" } as Bot}
            onSaved={vi.fn()}
            onConnect={vi.fn()}
            onKeysChange={(next) => {
              registered.keys = next;
            }}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(registered.keys).not.toBeNull());
    let stepped: boolean | undefined;
    act(() => {
      stepped = registered.keys?.stepThinking();
    });
    expect(stepped).toBe(true);
    await vi.waitFor(() =>
      expect(rpc.bots.update).toHaveBeenLastCalledWith({ botId: "bot-1", thinkingLevel: null }),
    );
  });

  it("keeps a one-level model on its default rather than saving the same level", async () => {
    const registered: { keys: ComposerModelKeys | null } = { keys: null };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker
            bot={{ ...bot, modelProvider: "acme", modelId: "steady" } as Bot}
            onSaved={vi.fn()}
            onConnect={vi.fn()}
            onKeysChange={(next) => {
              registered.keys = next;
            }}
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label^="Model"]')).not.toBeNull(),
    );
    vi.mocked(rpc.bots.update).mockClear();
    expect(registered.keys?.stepThinking()).toBe(false);
    expect(rpc.bots.update).not.toHaveBeenCalled();
  });

  it("saves a thinking level from beside the model list", async () => {
    const onSaved = vi.fn();
    const updated = { ...bot, thinkingLevel: "high" };
    vi.mocked(rpc.bots.update).mockResolvedValue(updated as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker bot={bot} onSaved={onSaved} onConnect={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    const trigger = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]');
      if (!button) throw new Error("not rendered yet");
      return button;
    });
    act(() => trigger.click());
    const high = await vi.waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (row) => row.textContent === "High",
      );
      if (!option) throw new Error("thinking levels not shown");
      return option;
    });
    expect(
      [...document.querySelectorAll('[role="option"]')].some(
        (row) => row.textContent === "Default (Medium)",
      ),
    ).toBe(true);
    act(() => high.click());

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated, "high"));
    expect(rpc.bots.update).toHaveBeenLastCalledWith({ botId: "bot-1", thinkingLevel: "high" });
  });

  it("still shows with nothing connected, and offers to connect a model", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([]);
    const onConnect = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ComposerModelPicker bot={bot} onSaved={vi.fn()} onConnect={onConnect} />
        </QueryClientProvider>,
      ),
    );
    const trigger = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]');
      if (!button) throw new Error("not rendered yet");
      return button;
    });
    act(() => trigger.click());
    const connect = await vi.waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (row) => row.textContent === "Connect a model",
      );
      if (!option) throw new Error("no connect row");
      return option;
    });
    act(() => connect.click());
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
