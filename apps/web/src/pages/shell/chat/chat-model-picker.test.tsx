// @vitest-environment jsdom

import type { ChatModelChoice } from "@rakazo/core";
import type { PopoverContent } from "@rakazo/ui-web/components/ui/popover";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatModelPicker } from "./chat-model-picker";

const { popoverProps } = vi.hoisted(() => ({ popoverProps: vi.fn() }));

vi.mock("@rakazo/ui-web/components/ui/popover", async (importOriginal) => {
  const actual = await importOriginal<{ PopoverContent: typeof PopoverContent }>();
  return {
    ...actual,
    PopoverContent: (props: ComponentProps<typeof PopoverContent>) => {
      popoverProps(props);
      return createElement(actual.PopoverContent, props);
    },
  };
});

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

/** Models of different families (`model-1a`, `model-2b`, ...), so none waits behind Show more. */
function choices(count: number): ChatModelChoice[] {
  const id = (index: number) => `vendor/model-${index + 1}${String.fromCharCode(97 + index)}`;
  return [
    { key: "", label: "Space default" },
    ...Array.from({ length: count }, (_, index) => ({
      key: `openrouter::${id(index)}`,
      label: `Model ${index + 1} (OpenRouter)`,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      modelLabel: `Model ${index + 1}`,
      modelId: id(index),
    })),
  ];
}

describe("ChatModelPicker", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();

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
    onChange.mockReset();
    popoverProps.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (list: ChatModelChoice[], value: string) =>
    act(() =>
      root.render(<ChatModelPicker id="model" choices={list} value={value} onChange={onChange} />),
    );
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const search = (text: string) =>
    act(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("lists a short list in the popover without a search box", () => {
    render(choices(9), "");
    expect(container.querySelector("select")).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>("button#model")!;
    expect(trigger.textContent).toBe("ModelSpace default");
    act(() => trigger.click());
    expect(options()).toHaveLength(10);
    expect(document.querySelector('input[aria-label="Search models"]')).toBeNull();
  });

  it("marks text-only rows and the selected model in a long list", () => {
    const list = choices(11).map((choice) =>
      choice.modelId === "vendor/model-3c" ? { ...choice, images: false } : choice,
    );
    render(list, "openrouter::vendor/model-3c");
    const trigger = container.querySelector<HTMLButtonElement>("button#model")!;
    expect(trigger.querySelector('[title="Can\'t read images"]')).not.toBeNull();
    act(() => trigger.click());
    const marked = options().filter((option) =>
      option.querySelector('[title="Can\'t read images"]'),
    );
    expect(marked.map((option) => option.textContent)).toEqual(["Model 3"]);
    expect(marked[0]?.getAttribute("aria-describedby")).toBe(
      trigger.getAttribute("aria-describedby"),
    );
  });

  it("searches a long list by name or id and picks from it", () => {
    render(choices(11), "openrouter::vendor/model-2b");
    expect(container.querySelector("select")).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>("button#model")!;
    expect(trigger.textContent).toBe("ModelModel 2 (OpenRouter)");

    act(() => trigger.click());
    expect(options()).toHaveLength(12);
    expect(document.querySelector("[cmdk-group-heading]")?.textContent).toBe("OpenRouter");
    expect(options()[1]?.textContent).toBe("Model 11");
    expect(options()[10]?.getAttribute("aria-label")).toBe("Model 2 (OpenRouter)");
    const checked = options().filter((option) => option.getAttribute("data-checked") === "true");
    expect(checked.map((option) => option.textContent)).toEqual(["Model 2"]);

    search("MODEL 1");
    expect(options().map((option) => option.textContent)).toEqual([
      "Model 11",
      "Model 10",
      "Model 1",
    ]);
    search("vendor/model-7");
    expect(options().map((option) => option.textContent)).toEqual(["Model 7"]);

    act(() => (options()[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("openrouter::vendor/model-7g");
    expect(options()).toHaveLength(0);
  });

  it("starts unfiltered after its owner closes and reopens it", () => {
    const show = (open: boolean) =>
      act(() =>
        root.render(
          <ChatModelPicker
            compact
            choices={choices(11)}
            value=""
            onChange={onChange}
            open={open}
            onOpenChange={vi.fn()}
          />,
        ),
      );
    show(true);
    search("vendor/model-7");
    expect(options()).toHaveLength(1);
    show(false);
    show(true);
    expect(options()).toHaveLength(12);
  });

  it("names its keys on the compact button's tooltip, and hides it while the list is open", async () => {
    act(() =>
      root.render(
        <ChatModelPicker
          compact
          choices={choices(2)}
          value=""
          onChange={onChange}
          hint="Model ⌘⇧M"
          keyShortcuts="Meta+Shift+M"
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]')!;
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+M");
    const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain("Model ⌘⇧M"));
    act(() => trigger.click());
    expect(options().length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(tooltip()).toBeNull());
  });

  it("shows each model's newest version until Show more lists the older ones", () => {
    const versions = ["4.5", "5.5", "5"].map((version) => ({
      key: `openrouter::vendor/model-${version}`,
      label: `Model ${version} (OpenRouter)`,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      modelLabel: `Model ${version}`,
      modelId: `vendor/model-${version}`,
    }));
    render(versions, "");
    act(() => container.querySelector<HTMLButtonElement>("button#model")!.click());
    expect(options().map((option) => option.textContent)).toEqual(["Model 5.5", "Show more"]);
    act(() => (options()[1] as HTMLElement).click());
    expect(options().map((option) => option.textContent)).toEqual([
      "Model 5.5",
      "Model 5",
      "Model 4.5",
    ]);
  });

  it("says when nothing matches", () => {
    render(choices(11), "");
    act(() => container.querySelector<HTMLButtonElement>("button#model")!.click());
    search("no such model");
    expect(options()).toHaveLength(0);
    expect(document.querySelector("[cmdk-group-heading]")).toBeNull();
    expect(document.body.textContent).toContain("No matching models");
  });

  it("lets the popup flip vertically without switching axes", () => {
    render(choices(11), "");
    act(() => container.querySelector<HTMLButtonElement>("button#model")!.click());
    expect(popoverProps.mock.lastCall?.[0]).toMatchObject({
      side: "bottom",
      align: "start",
      collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "none" },
    });
  });

  it("pins starred multi-provider models in a Favorites section, filters them, and toggles stars without selecting", () => {
    const onToggleStar = vi.fn();
    const multiProvider: ChatModelChoice[] = [
      {
        key: "anthropic::claude-sonnet-4-5",
        label: "Claude Sonnet 4.5 (Anthropic)",
        provider: "anthropic",
        providerLabel: "Anthropic",
        modelLabel: "Claude Sonnet 4.5",
        modelId: "claude-sonnet-4-5",
      },
      {
        key: "openrouter::claude-sonnet-4-5",
        label: "Claude Sonnet 4.5 (OpenRouter)",
        provider: "openrouter",
        providerLabel: "OpenRouter",
        modelLabel: "Claude Sonnet 4.5",
        modelId: "claude-sonnet-4-5",
      },
      {
        key: "openai::gpt-5",
        label: "GPT-5 (OpenAI)",
        provider: "openai",
        providerLabel: "OpenAI",
        modelLabel: "GPT-5",
        modelId: "gpt-5",
      },
    ];
    act(() =>
      root.render(
        <ChatModelPicker
          id="model"
          choices={multiProvider}
          value="anthropic::claude-sonnet-4-5"
          onChange={onChange}
          starredKeys={[
            "openai::gpt-5",
            "disconnected::retired-model",
            "openrouter::claude-sonnet-4-5",
          ]}
          onToggleStar={onToggleStar}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button#model")!.click());

    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Favorites", "Anthropic", "OpenRouter", "OpenAI"]);

    const favoritesGroup = document.querySelector("[cmdk-group]")!;
    const favoriteOptions = [...favoritesGroup.querySelectorAll('[role="option"]')];
    expect(favoriteOptions.map((option) => option.getAttribute("aria-label"))).toEqual([
      "GPT-5 (OpenAI)",
      "Claude Sonnet 4.5 (OpenRouter)",
    ]);
    // Favorite rows show the provider name to disambiguate across connected providers.
    expect(favoriteOptions[0]?.textContent).toContain("OpenAI");
    expect(favoriteOptions[1]?.textContent).toContain("OpenRouter");

    // Clicking the star button unstarring directly does not select the model or close the picker.
    const unstar = favoriteOptions[1]!.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Claude Sonnet 4.5 (OpenRouter) from favorites"]',
    )!;
    act(() => unstar.click());
    expect(onToggleStar).toHaveBeenCalledExactlyOnceWith("openrouter::claude-sonnet-4-5");
    expect(onChange).not.toHaveBeenCalled();
    expect(options().length).toBeGreaterThan(0);
  });

  it("hides the Favorites section when no starred models are connected", () => {
    act(() =>
      root.render(
        <ChatModelPicker
          id="model"
          choices={choices(2)}
          value=""
          onChange={onChange}
          starredKeys={["disconnected::retired-model"]}
          onToggleStar={vi.fn()}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button#model")!.click());
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["OpenRouter"]);
  });
});
