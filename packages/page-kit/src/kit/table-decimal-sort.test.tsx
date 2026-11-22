// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TableCell } from "./data.js";
import { Table } from "./data.js";
import { PageLanguage } from "./labels.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount();
  vi.unstubAllGlobals();
});

function mount(locale: string, rows: TableCell[][]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      <PageLanguage.Provider value={locale}>
        <Table columns={["Row", "Amount", ""]} rows={rows} sortable />
      </PageLanguage.Provider>,
    ),
  );
  const header = host.querySelector("th:nth-child(2)")!;
  const button = header.querySelector("button")!;
  return {
    sort: () => act(() => button.click()),
    order: () =>
      [...host.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent),
    ariaSort: () => header.getAttribute("aria-sort"),
    buttonCount: () => host.querySelectorAll("thead button").length,
  };
}

it("sorts unambiguous German decimals numerically, without a sort control on the blank heading", () => {
  const source: TableCell[][] = [
    ["grouped", "1.234,50"],
    ["decimal", "2,5"],
    ["fraction", "1,25"],
    ["numeric", 900],
    ["negative", "-0,5"],
    ["english-group", "1,234"],
    ["english-currency", "$1,200.50"],
  ];
  const view = mount("de-DE", source);
  expect(view.buttonCount()).toBe(2);
  view.sort();
  expect(view.ariaSort()).toBe("ascending");
  expect(view.order()).toEqual([
    "negative",
    "fraction",
    "decimal",
    "numeric",
    "english-currency",
    "english-group",
    "grouped",
  ]);
  view.sort();
  expect(view.ariaSort()).toBe("descending");
  expect(view.order()).toEqual([
    "grouped",
    "english-group",
    "english-currency",
    "numeric",
    "decimal",
    "fraction",
    "negative",
  ]);
  view.sort();
  expect(view.ariaSort()).toBeNull();
  expect(view.order()).toEqual(source.map(([key]) => key));
});

it("preserves sign, percent and magnitude suffixes with decimal commas", () => {
  const view = mount("de-DE", [
    ["thousands", "1,25k"],
    ["percent", "2,5%"],
    ["negative", "−€2,5"],
    ["fraction", "-0,05"],
    ["currency", "€1.234,50"],
  ]);
  view.sort();
  expect(view.order()).toEqual(["negative", "fraction", "percent", "currency", "thousands"]);
});

it("keeps standard English numbers, text, and blank values in their previous order", () => {
  const view = mount("en-US", [
    ["grouped", "1,234"],
    ["percentage", "-4.5%"],
    ["thousands", "1.5k"],
    ["text", "n/a"],
    ["currency", "$1,200.50"],
    ["decimal", "10.5"],
    ["legacy-comma", "1,25"],
    ["numeric", 999],
    ["empty", ""],
    ["word", "Alpha"],
    ["null", null],
    ["millions", "0.002M"],
    ["billions", "0.000003B"],
    ["grouped-millions", "1,234,567"],
  ]);
  view.sort();
  expect(view.order()).toEqual([
    "percentage",
    "decimal",
    "legacy-comma",
    "numeric",
    "currency",
    "grouped",
    "thousands",
    "millions",
    "billions",
    "grouped-millions",
    "empty",
    "null",
    "word",
    "text",
  ]);
});

it.each([
  { locale: "es-ES", order: ["comma", "numeric"] },
  { locale: "es-MX", order: ["numeric", "comma"] },
])("uses the page's regional number format in $locale", ({ locale, order }) => {
  const view = mount(locale, [
    ["numeric", 10],
    ["comma", "1,25"],
  ]);
  view.sort();
  expect(view.order()).toEqual(order);
});
