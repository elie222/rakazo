// @vitest-environment jsdom

import type { ModelHeaderRow } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { ModelHeadersEditor } from "./ModelHeadersEditor";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(rows: ModelHeaderRow[] | null, savedNames?: string[]) {
  act(() => {
    root.render(<ModelHeadersEditor rows={rows} savedNames={savedNames} onChange={vi.fn()} />);
  });
}

/** The text a screen reader announces for the element's aria-describedby. */
function described(element: Element) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

const valueFields = () => [
  ...host.querySelectorAll<HTMLInputElement>('input[aria-label="Header value"]'),
];
const removeButtons = () => [
  ...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove header"]'),
];

it("describes each row's value field and Remove button by that row's header name", () => {
  render([
    { name: "Authorization", value: "" },
    { name: "X-Org", value: "" },
  ]);

  expect(valueFields().map(described)).toEqual(["Authorization", "X-Org"]);
  expect(removeButtons().map(described)).toEqual(["Authorization", "X-Org"]);
});

it("describes saved header rows by their saved names", () => {
  render(null, ["x-session", "x-org"]);

  expect(valueFields().map(described)).toEqual(["x-session", "x-org"]);
  expect(removeButtons().map(described)).toEqual(["x-session", "x-org"]);
});

it("describes a row by the name typed so far, and by nothing while the name is empty", () => {
  render([{ name: "", value: "" }]);
  expect(described(valueFields()[0]!)).toBe("");
  expect(described(removeButtons()[0]!)).toBe("");

  render([{ name: "Proxy-Authorization", value: "" }]);
  expect(described(valueFields()[0]!)).toBe("Proxy-Authorization");
  expect(described(removeButtons()[0]!)).toBe("Proxy-Authorization");
});
