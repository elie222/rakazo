// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionSelect } from "./option-select.js";

const many = Array.from({ length: 12 }, (_, index) => ({
  value: index === 0 ? "" : `zone-${index}`,
  label: index === 0 ? "Default" : `Zone ${index}`,
}));

describe("OptionSelect", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onValueChange = vi.fn();

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
    onValueChange.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens a short list without a search field", () => {
    act(() => {
      root.render(
        createElement(OptionSelect, {
          id: "level",
          "aria-label": "Level",
          value: "low",
          options: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          onValueChange,
        }),
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button#level")!;
    act(() => trigger.click());
    expect(document.querySelector('input[aria-label="Search"]')).toBeNull();
    expect(
      [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(["Low", "High"]);
  });

  it("filters a long list and keeps an empty value selectable", () => {
    act(() => {
      root.render(
        createElement(OptionSelect, {
          id: "zone",
          "aria-label": "Timezone",
          value: "",
          options: many,
          onValueChange,
          searchLabel: "Search",
          emptyLabel: "No matches",
        }),
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button#zone")!;
    expect(trigger.textContent).toContain("Default");
    act(() => trigger.click());
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
    expect(search.closest(".p-1\\.5")).not.toBeNull();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(12);
    const type = (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          text,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });

    type("Zone 11");
    expect(
      [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(["Zone 11"]);

    type("nothing");
    expect(document.body.textContent).toContain("No matches");

    type("");
    const blank = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "Default",
    )!;
    act(() => blank.click());
    expect(onValueChange).toHaveBeenCalledWith("");
  });
});
