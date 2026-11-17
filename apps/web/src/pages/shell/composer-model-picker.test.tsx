// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => {
  const rpc = {
    bots: { update: vi.fn(), list: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => [{ provider: "acme", label: "Acme" }]),
      list: vi.fn(async () => [
        { provider: "acme", id: "fast", label: "Fast" },
        { provider: "acme", id: "smart", label: "Smart" },
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

const { rpc } = await import("../../lib/rpc");
const { ComposerModelPicker } = await import("./composer-model-picker");

const bot = { id: "bot-1", modelProvider: null, modelId: null } as unknown as Bot;

describe("ComposerModelPicker", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
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
          <ComposerModelPicker bot={bot} onSaved={onSaved} />
        </QueryClientProvider>,
      ),
    );

    const trigger = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]');
      if (!button) throw new Error("not rendered yet");
      return button;
    });
    expect(trigger.textContent).toContain("Fast");

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
});
