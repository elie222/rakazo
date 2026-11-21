// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DomainSearch, useDomainSearch } from "./domain-search";

const api = vi.hoisted(() => ({
  capabilities: { catalogSearch: vi.fn() },
}));

vi.mock("../../lib/query/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness() {
  const state = useDomainSearch();
  return <DomainSearch state={state} onBack={() => {}} onPick={() => {}} />;
}

/** Types a domain and presses Search, as a keyboard user does. */
async function searchFor(domain: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, domain);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
  await act(async () => button.click());
}

function liveRegion(role: "alert" | "status") {
  return container.querySelector(`[role="${role}"]`);
}

it("announces a failed catalog search through an alert region", async () => {
  api.capabilities.catalogSearch.mockRejectedValue(new Error("Catalog is down for maintenance"));
  await act(async () => root.render(<Harness />));
  // The region is mounted before the search, so the failure text is announced when it arrives.
  const alert = liveRegion("alert");
  expect(alert?.textContent).toBe("");

  await searchFor("github.com");

  expect(liveRegion("alert")).toBe(alert);
  expect(alert?.textContent).toBe("Catalog is down for maintenance");
  expect(liveRegion("status")?.textContent).toBe("");
});

it("announces an empty catalog answer through a status region", async () => {
  api.capabilities.catalogSearch.mockResolvedValue({ results: [] });
  await act(async () => root.render(<Harness />));
  const status = liveRegion("status");
  expect(status?.textContent).toBe("");

  await searchFor("github.com");

  expect(liveRegion("status")).toBe(status);
  expect(status?.textContent).toBe("No results");
  expect(liveRegion("alert")?.textContent).toBe("");
});

it("keeps both regions silent while a search has results", async () => {
  api.capabilities.catalogSearch.mockResolvedValue({
    results: [
      {
        domain: "github.com",
        name: "GitHub",
        pageUrl: null,
        description: "",
        surfaces: [],
      },
    ],
  });
  await act(async () => root.render(<Harness />));

  await searchFor("github.com");

  expect(container.textContent).toContain("GitHub");
  expect(liveRegion("alert")?.textContent).toBe("");
  expect(liveRegion("status")?.textContent).toBe("");
});
