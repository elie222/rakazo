// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import { ModelPicker } from "./model-picker";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const deepseekEntry: ModelCatalogEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key",
  authHint: "API key",
};

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
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(element: Element | null, value: string) {
  await act(async () => {
    element?.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  });
}

async function renderPicker(options: ModelCatalogEntry[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let selectModel = (_value: string) => {};
  function Picker() {
    const [value, setValue] = useState(options[0]?.id ?? "");
    selectModel = setValue;
    return <ModelPicker options={options} value={value} onChange={setValue} />;
  }
  await act(async () => root.render(<Picker />));
  return {
    container,
    async select(value: string) {
      await act(async () => selectModel(value));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function activeOption(input: HTMLInputElement) {
  const id = input.getAttribute("aria-activedescendant");
  expect(id).toBeTruthy();
  const option = document.getElementById(id!);
  expect(option?.getAttribute("role")).toBe("option");
  expect(option?.getAttribute("aria-selected")).toBe("true");
  return option;
}

it("warns only on text-only models in the picker", async () => {
  const view = await renderPicker([
    { ...deepseekEntry, images: false },
    { ...deepseekEntry, id: "deepseek-vision", label: "DeepSeek Vision", images: true },
    { ...deepseekEntry, id: "deepseek-unknown", label: "DeepSeek Unknown" },
  ]);
  try {
    const describedAs = (element: Element) =>
      (element.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => (id ? document.getElementById(id)?.textContent : null))
        .filter(Boolean)
        .join(" ");
    const marked = (element: Element) =>
      Boolean(element.querySelector(`[title="Can't read images"]`));
    const trigger = view.container.querySelector('button[role="combobox"]');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing model picker");
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Chat",
      true,
      "Can't read images",
    ]);
    await act(async () => {
      trigger.click();
    });
    const searchInput = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(document.getElementById(searchInput.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Search models",
    );
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      "Model options",
    );
    expect(activeOption(searchInput)?.textContent).toBe("DeepSeek Chat");
    const options = [...document.querySelectorAll('[role="option"]')];
    // The label stays the model name; the icon is for eyes, the description for screen readers.
    expect(
      options.map((option) => [option.textContent, marked(option), describedAs(option)]),
    ).toEqual([
      ["DeepSeek Chat", true, "Can't read images"],
      ["DeepSeek Vision", false, ""],
      ["DeepSeek Unknown", false, ""],
    ]);
    await act(async () => {
      (options[1] as HTMLButtonElement).click();
    });
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Vision",
      false,
      "",
    ]);
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      (document.querySelector('[role="option"]') as HTMLButtonElement).click();
    });
    expect([trigger.textContent, marked(trigger), describedAs(trigger)]).toEqual([
      "DeepSeek Chat",
      true,
      "Can't read images",
    ]);
  } finally {
    await view.unmount();
  }
});

it("highlights the last model when ArrowUp reopens a searched picker", async () => {
  const view = await renderPicker([
    deepseekEntry,
    { ...deepseekEntry, id: "deepseek-vision", label: "DeepSeek Vision" },
    { ...deepseekEntry, id: "deepseek-unknown", label: "DeepSeek Unknown" },
  ]);
  try {
    const trigger = view.container.querySelector('button[role="combobox"]');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing model picker");
    const search = () => document.querySelector('input[aria-label="Search models"]');
    await act(async () => {
      trigger.click();
    });
    await typeInto(search() as HTMLInputElement, "Vision");
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(activeOption(search() as HTMLInputElement)?.textContent).toBe("DeepSeek Unknown");
    await key(search(), "Enter");
    expect(trigger.textContent).toBe("DeepSeek Unknown");
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(trigger);
  } finally {
    await view.unmount();
  }
});

it("navigates model rows with Home, End, and arrows before selecting", async () => {
  const view = await renderPicker([
    deepseekEntry,
    { ...deepseekEntry, id: "vision", label: "Vision" },
    { ...deepseekEntry, id: "reasoner", label: "Reasoner" },
  ]);
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => trigger.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await key(input, "End");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe(
      "Reasoner",
    );
    await key(input, "ArrowDown");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe(
      "DeepSeek Chat",
    );
    await key(input, "End");
    await key(input, "Home");
    await key(input, "ArrowDown");
    await key(input, "Enter");
    expect(trigger.textContent).toBe("Vision");
  } finally {
    await view.unmount();
  }
});

it("ignores selection for an empty search and resets search when reopened", async () => {
  const view = await renderPicker([deepseekEntry]);
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => trigger.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await typeInto(input, "absent-model");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("No matching models");
    await key(input, "Enter");
    expect(trigger.textContent).toBe("DeepSeek Chat");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await key(input, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.value,
    ).toBe("");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

it("closes when the selected model changes outside the picker", async () => {
  const view = await renderPicker([
    deepseekEntry,
    { ...deepseekEntry, id: "vision", label: "Vision" },
  ]);
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await view.select("vision");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("Vision");
  } finally {
    await view.unmount();
  }
});

it("associates the active option immediately when filtering commits new rows", async () => {
  const view = await renderPicker([
    deepseekEntry,
    { ...deepseekEntry, id: "vision-small", label: "Vision Small" },
    { ...deepseekEntry, id: "vision-large", label: "Vision Large" },
  ]);
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => trigger.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    expect(activeOption(input)?.textContent).toBe("DeepSeek Chat");
    await typeInto(input, "Vision");
    const firstFiltered = activeOption(input);
    expect(firstFiltered?.textContent).toBe("Vision Small");
    expect(firstFiltered?.closest("[hidden]")).toBeNull();
    await key(input, "ArrowDown");
    expect(activeOption(input)?.textContent).toBe("Vision Large");
    await key(input, "Home");
    expect(activeOption(input)).toBe(firstFiltered);
    await typeInto(input, "absent");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  } finally {
    await view.unmount();
  }
});
