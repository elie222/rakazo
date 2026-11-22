// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FoundModelPicker } from "../../components/models/FoundModelPicker";
import { ProvidersSection } from "./providers-section";
import { RoleModelPicker } from "./role-model-picker";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
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
  Element.prototype.scrollIntoView = () => {};
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const providers = Array.from({ length: 11 }, (_, index) => ({
  id: `provider-${index}`,
  name: index === 0 ? "Café provider" : `Provider ${index}`,
}));
const input = () => document.querySelector<HTMLInputElement>("input")!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );
}
const options = () => [...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent);

it("uses the shared matcher in Add provider and keeps an active search after the list shrinks", async () => {
  const render = (rows: typeof providers) =>
    root.render(
      <ProvidersSection
        credentials={[]}
        providers={rows}
        name={() => ""}
        onAdd={() => {}}
        onOpen={() => {}}
      />,
    );
  await act(async () => render(providers.slice(0, 10)));
  await click("Add provider");
  expect(input()).toBeNull();
  await act(async () => render(providers));
  expect(input()).not.toBeNull();
  await type(" CAFÉ ");
  expect(options()).toEqual(["Café provider"]);
  await act(async () => render(providers.slice(0, 1)));
  expect(input().value).toBe(" CAFÉ ");
  await type("");
  expect(input()).toBeNull();
});

it("searches role models and providers together, including provider names and model ids", async () => {
  const onPick = vi.fn();
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={[
          {
            id: "café-model",
            label: "Model",
            provider: "fixture",
            providerName: "Café",
            billing: "API key",
          },
        ]}
        providers={providers.slice(0, 10)}
        onPick={onPick}
        onConnect={() => {}}
      />,
    ),
  );
  await click("Choose");
  await type(" CAFÉ ");
  expect(options()).toEqual(["Model", "Café providerConnect"]);
  await type("café-model");
  expect(options()).toEqual(["Model"]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "café-model" }));
});

it("searches Onboarding's discovered models and keeps manual model entry available", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <FoundModelPicker
        models={providers.map((row) => row.name)}
        value="Café provider"
        otherValue="manual"
        onChange={onChange}
      />,
    ),
  );
  await click("Café provider");
  await type(" CAFÉ ");
  expect(options()).toEqual(["Café provider", "Other model…"]);
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>("[cmdk-item]")]
      .find((row) => row.textContent === "Other model…")!
      .click(),
  );
  expect(onChange).toHaveBeenCalledWith("manual");
});

it("keeps a short role list usable from the keyboard without search", async () => {
  const onConnect = vi.fn();
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={[]}
        providers={providers.slice(0, 1)}
        onPick={() => {}}
        onConnect={onConnect}
      />,
    ),
  );
  await click("Choose");
  expect(input()).toBeNull();
  const command = document.querySelector<HTMLElement>("[cmdk-root]")!;
  expect(command.tabIndex).toBe(0);
  await act(async () =>
    command.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onConnect).toHaveBeenCalledWith(providers[0]);
});

// Enough rows for the search box to show.
const currentModels = [
  "Newest",
  "Older",
  ...Array.from({ length: 10 }, (_, i) => `Other ${i}`),
].map((label) => ({
  id: label.toLowerCase().replace(" ", "-"),
  label,
  provider: "fixture",
  providerName: "Fixture",
  billing: "",
}));
async function renderCurrent(onPick: () => void) {
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={currentModels}
        providers={[]}
        current={{ provider: "fixture", modelId: "older" }}
        onPick={onPick}
        onConnect={() => {}}
      />,
    ),
  );
  await click("Choose");
}
const rowState = () =>
  [...document.querySelectorAll("[cmdk-item]")].flatMap((row) =>
    row.getAttribute("data-checked") === "true" || row.getAttribute("aria-selected") === "true"
      ? [[row.textContent, row.getAttribute("data-checked"), row.getAttribute("aria-selected")]]
      : [],
  );

it("checks the model in use and starts on it, so Enter keeps it without saving", async () => {
  const onPick = vi.fn();
  await renderCurrent(onPick);
  expect(rowState()).toEqual([["Older", "true", "true"]]);
  await act(async () =>
    document
      .querySelector<HTMLElement>("[cmdk-root]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).not.toHaveBeenCalled();
});

it("moves the active row to the first match when searching", async () => {
  const onPick = vi.fn();
  await renderCurrent(onPick);
  await type("newest");
  expect(rowState()).toEqual([["Newest", "false", "true"]]);
  await act(async () =>
    document
      .querySelector<HTMLElement>("[cmdk-root]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "newest" }));
});

it("returns the active row to the model in use when the search is cleared", async () => {
  const onPick = vi.fn();
  await renderCurrent(onPick);
  await type("newest");
  await type("");
  expect(rowState()).toEqual([["Older", "true", "true"]]);
  await act(async () =>
    document
      .querySelector<HTMLElement>("[cmdk-root]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).not.toHaveBeenCalled();
});

it("does not mark or pick a connection of your own when the included model is in use", async () => {
  const onPick = vi.fn();
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={[
          {
            id: "included",
            label: "Own",
            provider: "fixture",
            providerName: "Fixture",
            billing: "",
            credentialId: "cred-1",
          },
          ...currentModels.slice(0, 1),
        ]}
        providers={[]}
        defaultOption={{ label: "Included" }}
        current={{ provider: "fixture", modelId: "included" }}
        onPick={onPick}
        onConnect={() => {}}
      />,
    ),
  );
  await click("Choose");
  expect(document.querySelector('[data-checked="true"]')).toBeNull();
  expect(rowState().some(([text]) => text === "Own")).toBe(false);
  await act(async () =>
    document
      .querySelector<HTMLElement>("[cmdk-root]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).toHaveBeenCalledWith(null);
});

it("checks a model saved under a provider's older id", async () => {
  const onPick = vi.fn();
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={[
          { id: "first", label: "First", provider: "azure", providerName: "Azure", billing: "" },
          { id: "saved", label: "Saved", provider: "azure", providerName: "Azure", billing: "" },
        ]}
        providers={[]}
        current={{ provider: "azure-openai-responses", modelId: "saved" }}
        onPick={onPick}
        onConnect={() => {}}
      />,
    ),
  );
  await click("Choose");
  expect(rowState()).toEqual([["Saved", "true", "true"]]);
  await act(async () =>
    document
      .querySelector<HTMLElement>("[cmdk-root]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).not.toHaveBeenCalled();
});
