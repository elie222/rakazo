// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "../../lib/platform/desktop";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/i18n/app-icon", () => ({ appIconLabel: (icon: string) => icon }));

import { AppIconPicker } from "./AppIconPicker";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

function pressed() {
  return container.querySelector("[aria-pressed=true]")?.getAttribute("aria-label");
}

it("goes back to the current icon when the desktop app refuses the change", async () => {
  const set = vi.fn(async () => false);
  window.rakazoDesktop = {
    appIcon: { get: async () => "default", set },
  } as unknown as RakazoDesktop;
  await act(async () => root.render(<AppIconPicker />));
  expect(pressed()).toBe("default");

  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label=cap]")?.click());

  expect(set).toHaveBeenCalledWith("cap");
  expect(pressed()).toBe("default");
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't change the app icon");
});
