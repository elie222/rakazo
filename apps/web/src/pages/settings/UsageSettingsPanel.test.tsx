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
const catalog = vi.hoisted(() => ({
  entries: [] as { provider: string; id: string; label: string; providerName?: string }[] | Error,
}));

vi.mock("../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  useSpaceQueries: () => ({
    models: {
      list: {
        queryOptions: () => ({
          queryKey: ["models-list"],
          queryFn: async () => {
            if (catalog.entries instanceof Error) throw catalog.entries;
            return catalog.entries;
          },
        }),
      },
    },
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
    {
      provider: input.provider ?? "p:1",
      model: input.model ?? "m1",
      ...point(3, 400, 0.04),
      cachedTokens: 250,
    },
  ],
  overTimeUnit: "day",
  overTime: [{ date: "2026-11-10", ...point(3, 400, 0.04) }],
});

const settle = () => act(flush);

async function renderPanel(entries: typeof catalog.entries = []) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  breakdown.fetch.mockReset();
  catalog.entries = entries;
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
    refetchCatalog: async () => {
      await act(async () => client.refetchQueries({ queryKey: ["models-list"] }));
      await settle();
    },
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
    ).toEqual([["2. Unlisted model", "3", "399", "250", "1", "$0.04"]]);

    await panel.choose("Bot", "Alpha");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({ range: "30d", botId: "bot-a" });
    expect(panel.totals()).toEqual(["2", "400", "$0.04"]);

    // The model list keeps every model, and a provider id with a colon survives the round trip.
    await panel.choose("Model", "2. Unlisted model");
    expect(breakdown.fetch).toHaveBeenLastCalledWith({
      range: "30d",
      botId: "bot-a",
      provider: "p:1",
      model: "m1",
    });
    expect(await panel.options("Model")).toEqual([
      "All models",
      "2. Unlisted model",
      "1. Unlisted model",
    ]);

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

it("marks a token total that leaves out calls with no count", async () => {
  const panel = await renderPanel();
  try {
    breakdown.fetch.mockImplementation(async (input: Input) => {
      const usage = usageFor(input);
      return { ...usage, totals: { ...usage.totals, tokensPartial: true } };
    });
    await panel.pick("Today");
    expect(panel.totals()).toEqual(["3", "467+", "$0.04"]);
  } finally {
    await panel.unmount();
  }
});

it("says the request failed instead of showing zero spend", async () => {
  const panel = await renderPanel();
  try {
    await panel.choose("Bot", "Alpha");
    await panel.choose("Model", "2. Unlisted model");
    breakdown.fetch.mockRejectedValue(new Error("offline"));
    await panel.pick("Today");
    expect(panel.chosen("Bot")).toBe("Alpha");
    expect(panel.chosen("Model")).toBe("2. Unlisted model");
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
      "1. Unlisted model",
      "3. Unlisted model",
      "2. Unlisted model",
    ]);
  } finally {
    await panel.unmount();
  }
});

it("draws every bar on one baseline and puts the dates in a separate row", async () => {
  const panel = await renderPanel();
  try {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      ...point(1, i === 29 ? 900 : 100, 0.01),
    }));
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      overTime: days,
    }));
    await panel.pick("7 days");
    // jsdom does no layout, so this checks the structure that gives the shared baseline,
    // not the measured pixels.
    const bars = panel.container.querySelector('[data-testid="usage-bars"]')!;
    const axis = panel.container.querySelector('[data-testid="usage-axis"]')!;
    expect(bars.children).toHaveLength(30);
    for (const bar of bars.children) {
      expect(bar.textContent).toBe("");
      expect(bar.getAttribute("aria-label")).toMatch(/tokens/);
    }
    expect(bars.contains(axis)).toBe(false);
    expect(axis.getAttribute("aria-hidden")).toBe("true");
    const labels = [...axis.children];
    expect(labels).toHaveLength(2);
    expect(labels[0]?.className).toContain("text-start");
    expect(labels[1]?.className).toContain("text-end");
    expect(labels.map((label) => label.className).join(" ")).not.toContain("truncate");
  } finally {
    await panel.unmount();
  }
});

it("names models and providers by their labels, and hides identifiers when none is known", async () => {
  const panel = await renderPanel([
    { provider: "openai-codex", id: "gpt-6-luna", label: "GPT-6 Luna", providerName: "ChatGPT" },
    { provider: "alpha", id: "shared", label: "Shared Model", providerName: "Alpha AI" },
    { provider: "alpha", id: "shared-v2", label: "Shared Model", providerName: "Alpha AI" },
    { provider: "beta", id: "shared", label: "Shared Model", providerName: "Beta AI" },
  ]);
  try {
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      modelOptions: [
        { provider: "openai-codex", model: "gpt-6-luna" },
        { provider: "alpha", model: "shared" },
        { provider: "alpha", model: "shared-v2" },
        { provider: "beta", model: "shared" },
        { provider: "custom", model: "my-model" },
      ],
      models: [
        { provider: "openai-codex", model: "gpt-6-luna", ...point(3, 400, 0.04) },
        { provider: "custom", model: "my-model", ...point(1, 10, 0.001) },
      ],
    }));
    await panel.pick("7 days");
    expect(
      [...panel.container.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("td")?.textContent,
      ),
    ).toEqual(["5. GPT-6 LunaChatGPT", "4. Unlisted model"]);
    expect(await panel.options("Model")).toEqual([
      "All models",
      "5. GPT-6 Luna",
      "1. Shared Model (Alpha AI)",
      "2. Shared Model (Alpha AI)",
      "3. Shared Model (Beta AI)",
      "4. Unlisted model",
    ]);
  } finally {
    await panel.unmount();
  }
});

it("distinguishes a failed catalog read from an unlisted model", async () => {
  const panel = await renderPanel(new Error("catalog offline"));
  try {
    expect(panel.container.textContent).toContain("Model name unavailable");
    expect(panel.container.textContent).not.toContain("Unlisted model");
    expect(panel.totals()).toEqual(["3", "467", "$0.04"]);
  } finally {
    await panel.unmount();
  }
});

it("uses stable matching references for table rows and colliding final filter labels", async () => {
  const entries = [
    { provider: "a", id: "opaque-a", label: "Foo (Bar)", providerName: "Quux" },
    { provider: "b", id: "opaque-b", label: "Foo", providerName: "Bar" },
    { provider: "c", id: "opaque-c", label: "Foo", providerName: "Baz" },
  ];
  const panel = await renderPanel(entries);
  try {
    let options = entries.map((entry) => ({ provider: entry.provider, model: entry.id }));
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      modelOptions: options,
      models: options.map((option) => ({ ...option, ...point(1, 10, 0.001) })),
    }));
    await panel.pick("7 days");
    const labels = ["1. Foo (Bar)", "2. Foo (Bar)", "3. Foo (Baz)"];
    expect(await panel.options("Model")).toEqual(["All models", ...labels]);
    const rowLabels = () =>
      [...panel.container.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("td > div")?.textContent,
      );
    expect(rowLabels()).toEqual(labels);
    await panel.choose("Model", labels[1]!);
    expect(breakdown.fetch).toHaveBeenLastCalledWith({
      range: "7d",
      provider: "b",
      model: "opaque-b",
    });
    options = [...options].reverse();
    await panel.pick("Today");
    expect(await panel.options("Model")).toEqual(["All models", ...[...labels].reverse()]);
    expect(rowLabels()).toEqual([...labels].reverse());
    expect(panel.container.textContent).not.toContain("opaque-");
  } finally {
    await panel.unmount();
  }
});

it("keeps a known provider name when the recorded model is no longer listed", async () => {
  const panel = await renderPanel([
    { provider: "alpha", id: "current", label: "Current model", providerName: "Alpha AI" },
  ]);
  try {
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      modelOptions: [{ provider: "alpha", model: "retired-opaque-id" }],
      models: [{ provider: "alpha", model: "retired-opaque-id", ...point(1, 10, 0.001) }],
    }));
    await panel.pick("7 days");
    expect(panel.container.querySelector("tbody tr td")?.textContent).toBe(
      "Unlisted modelAlpha AI",
    );
    expect(panel.container.textContent).not.toContain("retired-opaque-id");
    expect(await panel.options("Model")).toEqual(["All models", "Unlisted model"]);
  } finally {
    await panel.unmount();
  }
});

it("keeps cached catalog names and unlisted labels after a failed refresh", async () => {
  const panel = await renderPanel([
    { provider: "p:1", id: "m1", label: "Known model", providerName: "Known provider" },
  ]);
  try {
    breakdown.fetch.mockImplementation(async (input: Input) => ({
      ...usageFor(input),
      models: [
        { provider: "p:1", model: "m1", ...point(1, 10, 0.001) },
        { provider: "p", model: "m2", ...point(1, 10, 0.001) },
      ],
    }));
    await panel.pick("7 days");
    catalog.entries = new Error("catalog refresh failed");
    await panel.refetchCatalog();
    expect(
      [...panel.container.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("td")?.textContent,
      ),
    ).toEqual(["Known modelKnown provider", "Unlisted model"]);
    expect(await panel.options("Model")).toEqual(["All models", "Known model", "Unlisted model"]);
    expect(panel.container.textContent).not.toContain("Model name unavailable");
  } finally {
    await panel.unmount();
  }
});
