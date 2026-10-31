// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompatibleModelFields } from "./compatible-model-fields";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const rows = (count: number) => Array.from({ length: count }, (_, index) => `model-${index + 1}`);

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function props(compatibleRows: string[], enabledModelIds: string[]) {
  return {
    resetOpenAiCompatibleProbe: () => {},
    headerRows: null,
    setHeaderRows: () => {},
    savedHeaderEndpointMatches: false,
    credential: undefined,
    baseUrl: "http://127.0.0.1:8000/v1",
    busy: false,
    cancelOAuthAttempt: () => {},
    compatibleRows,
    contextWindow: "128000",
    defaultModelOptions: [],
    effectiveBaseUrl: "http://127.0.0.1:8000/v1",
    enabledModelIds,
    invalidatePreflight: () => {},
    maxImagesPerPrompt: "",
    maxTokens: "4096",
    modelId: "",
    preflightFailure: null,
    preflightTarget: null,
    probeModels: [],
    probeServerModels: () => Promise.resolve(),
    probing: false,
    reasoning: false,
    selectionRevisionRef: { current: 0 },
    setContextWindow: () => {},
    setEnabledModelIds: () => {},
    setError: () => {},
    setMaxImagesPerPrompt: () => {},
    setMaxTokens: () => {},
    setNotice: () => {},
    setReasoning: () => {},
    setSupportsImages: () => {},
    setThinkingLevel: () => {},
    stageCompatibleModelId: () => {},
    supportsImages: false,
    thinkingLevel: null,
    updateBaseUrl: () => {},
  };
}

async function renderFields(compatibleRows: string[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Fields() {
    const [enabled, setEnabled] = useState<string[]>([]);
    return (
      <CompatibleModelFields
        {...props(compatibleRows, enabled)}
        setEnabledModelIds={(update) =>
          setEnabled((current) => (typeof update === "function" ? update(current) : update))
        }
      />
    );
  }
  await act(async () => root.render(<Fields />));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function search() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
}

function modelRows(container: HTMLElement) {
  return [
    ...(container
      .querySelector('[data-testid="compatible-model-rows"]')
      ?.querySelectorAll('[data-slot="checkbox"]') ?? []),
  ];
}

function visibleRows(container: HTMLElement) {
  return modelRows(container).map((checkbox) => checkbox.parentElement?.textContent?.trim());
}

function rowCheckbox(container: HTMLElement, id: string) {
  return modelRows(container).find(
    (checkbox) => checkbox.parentElement?.textContent?.trim() === id,
  ) as HTMLElement | undefined;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("leaves a short discovered list without a search field", async () => {
  const view = await renderFields(rows(3));
  try {
    expect(visibleRows(view.container)).toEqual(["model-1", "model-2", "model-3"]);
    expect(search()).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("filters a long discovered list and keeps hidden ticks", async () => {
  const view = await renderFields(rows(12));
  try {
    const input = search();
    if (!input) throw new Error("Missing model search");
    expect(visibleRows(view.container)).toHaveLength(12);

    const ticked = rowCheckbox(view.container, "model-7");
    if (!ticked) throw new Error("Missing model-7 row");
    await act(async () => ticked.click());
    expect(ticked.getAttribute("aria-checked")).toBe("true");

    await typeInto(input, "model-1");
    expect(visibleRows(view.container)).toEqual(["model-1", "model-10", "model-11", "model-12"]);

    await typeInto(input, "model-7");
    expect(visibleRows(view.container)).toEqual(["model-7"]);
    expect(rowCheckbox(view.container, "model-7")?.getAttribute("aria-checked")).toBe("true");

    await typeInto(input, "nothing-matches");
    expect(visibleRows(view.container)).toEqual([]);
    expect(view.container.textContent).toContain("No matching models");

    await typeInto(input, "");
    expect(visibleRows(view.container)).toHaveLength(12);
    expect(rowCheckbox(view.container, "model-7")?.getAttribute("aria-checked")).toBe("true");
  } finally {
    await view.unmount();
  }
});
