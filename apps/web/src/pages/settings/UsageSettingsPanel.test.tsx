// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type * as QueryModule from "../../lib/query/query";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  OptionSelect: (await importOriginal<typeof UiWeb>()).OptionSelect,
  Tooltip: (await importOriginal<typeof UiWeb>()).Tooltip,
  TooltipTrigger: (await importOriginal<typeof UiWeb>()).TooltipTrigger,
  TooltipContent: (await importOriginal<typeof UiWeb>()).TooltipContent,
  SectionHeading: (await importOriginal<typeof UiWeb>()).SectionHeading,
  ToggleGroup: (await importOriginal<typeof UiWeb>()).ToggleGroup,
  ToggleGroupItem: (await importOriginal<typeof UiWeb>()).ToggleGroupItem,
}));

const breakdown = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  useSpaceQueries: () => ({
    usage: {
      breakdown: {
        queryOptions: ({ input }: { input: unknown }) => ({
          queryKey: ["usage-breakdown", input],
          queryFn: () => breakdown.fetch(input),
        }),
      },
    },
  }),
}));

import { UsageSettingsPanel } from "./UsageSettingsPanel";

type Input = { botId?: string; provider?: string; model?: string; range: string };

const point = (modelCalls: number, totalTokens: number, costUsd: number | null) => ({
  modelCalls,
  inputTokens: totalTokens - 1,
  outputTokens: 1,
  totalTokens,
  costUsd,
});

const usageFor = (input: Input) => ({
  range: input.range,
  bots: [
    { id: "bot-a", name: "Alpha", deleted: false, runs: 2, ...point(3, 400, 0.04) },
    { id: "bot-b", name: "Old bot", deleted: true, runs: 1, ...point(1, 67, 0.003) },
  ],
  modelOptions: [
    { provider: "p:1", model: "m1" },
    { provider: "p", model: "m2" },
  ],
  totals: {
    runs: input.botId ? 2 : 3,
    ...point(input.botId ? 3 : 4, input.botId ? 400 : 467, 0.04),
  },
  models: [
    { provider: input.provider ?? "p:1", model: input.model ?? "m1", ...point(3, 400, 0.04) },
  ],
  overTimeUnit: "day",
  overTime: [{ date: "2026-11-10", ...point(3, 400, 0.04) }],
});

const settle = () => act(flush);

async function renderPanel() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  breakdown.fetch.mockReset();
  breakdown.fetch.mockImplementation(async (input: Input) => usageFor(input));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UsageSettingsPanel />
      </QueryClientProvider>,
    ),
  );
  await settle();
  const trigger = (label: string) =>
    container.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`)!;
  const open = async (label: string) => {
    await act(async () => trigger(label).click());
    const list = document.getElementById(trigger(label).getAttribute("aria-controls") ?? "");
    return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  };
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
  return {
    container,
    chosen: (label: string) => trigger(label).textContent,
    totals: () => [...container.querySelectorAll("dd")].map((node) => node.textContent),
    options: async (label: string) => {
      const texts = (await open(label)).map((option) => option.textContent);
      await act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
      return texts;
    },
    choose: async (label: string, text: string) => {
      const option = (await open(label)).find((entry) => entry.textContent === text);
      if (!option) throw new Error(`no ${text} option`);
      await act(async () => option.click());
      await settle();
    },
    pick: async (text: string) => {
      await act(async () => button(text).click());
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("shows every bot's usage first, then narrows it by bot, model and date range", async () => {
  const panel = await renderPanel();
  try {
    expect(breakdown.fetch).toHaveBeenLastCalledWith({ range: "30d" });
    expect(panel.totals()).toEqual(["3", "467", "$0.04"]);
    expect(await panel.options("Bot")).toEqual(["All bots", "Alpha", "Old bot (deleted)"]);
    expect(
      [...panel.container.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    ).toEqual([["m1p:1", "3", "399", "1", "$0.04"]]);

    await panel.choose("Bot", "Alpha");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({ range: "30d", botId: "bot-a" });
    expect(panel.totals()).toEqual(["2", "400", "$0.04"]);

    // The model list keeps every model, and a provider id with a colon survives the round trip.
    await panel.choose("Model", "m1");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({
      range: "30d",
      botId: "bot-a",
      provider: "p:1",
      model: "m1",
    });
    expect(await panel.options("Model")).toEqual(["All models", "m1", "m2"]);

    await panel.pick("7 days");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({
      range: "7d",
      botId: "bot-a",
      provider: "p:1",
      model: "m1",
    });
  } finally {
    await panel.unmount();
  }
});

it("goes back to all bots when the chosen bot has no usage in the new range", async () => {
  const panel = await renderPanel();
  try {
    await panel.choose("Bot", "Old bot (deleted)");
    expect(panel.chosen("Bot")).toBe("Old bot (deleted)");
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      bots: [{ id: "bot-a", name: "Alpha", deleted: false, runs: 2, ...point(3, 400, 0.04) }],
    }));
    await panel.pick("Today");
    expect(panel.chosen("Bot")).toBe("All bots");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({ range: "today" });
  } finally {
    await panel.unmount();
  }
});

it("does not show the previous selection's numbers while the next one loads", async () => {
  const panel = await renderPanel();
  try {
    expect(panel.totals()).toEqual(["3", "467", "$0.04"]);
    const pending = deferred<unknown>();
    breakdown.fetch.mockImplementation(() => pending.promise);
    await panel.pick("Today");
    expect(panel.totals()).toEqual(["—", "—", "—"]);
    expect(panel.container.textContent).toContain("Loading usage…");
    // The filters stay usable from the last result.
    expect(await panel.options("Bot")).toEqual(["All bots", "Alpha", "Old bot (deleted)"]);
    await act(async () => pending.resolve(usageFor({ range: "today" })));
    await settle();
    expect(panel.totals()).toEqual(["3", "467", "$0.04"]);
  } finally {
    await panel.unmount();
  }
});

it("says the request failed instead of showing zero spend", async () => {
  const panel = await renderPanel();
  try {
    await panel.choose("Bot", "Alpha");
    await panel.choose("Model", "m1");
    breakdown.fetch.mockRejectedValue(new Error("offline"));
    await panel.pick("Today");
    expect(panel.chosen("Bot")).toBe("Alpha");
    expect(panel.chosen("Model")).toBe("m1");
    expect(panel.totals()).toEqual(["—", "—", "—"]);
    expect(panel.container.textContent).toContain("Could not load usage.");
    expect(panel.container.textContent).not.toContain("No usage for this selection.");
  } finally {
    await panel.unmount();
  }
});

it("tells apart a model name that two providers share", async () => {
  const panel = await renderPanel();
  try {
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      modelOptions: [
        { provider: "alpha", model: "shared" },
        { provider: "beta", model: "shared" },
        { provider: "alpha", model: "solo" },
      ],
    }));
    await panel.pick("7 days");
    expect(await panel.options("Model")).toEqual([
      "All models",
      "shared (alpha)",
      "shared (beta)",
      "solo",
    ]);
  } finally {
    await panel.unmount();
  }
});
