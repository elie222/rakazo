// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "../../lib/platform/desktop";
import { createQueryRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/i18n/app-icon", () => ({ appIconLabel: (icon: string) => icon }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: {},
  rpcForSpace: () => ({}),
  createSpaceRpc: () => ({}),
  selectedSpaceId: () => null,
}));

import { AppIconPicker } from "./AppIconPicker";

let root: ReturnType<typeof createQueryRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createQueryRoot(container);
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
  await vi.waitFor(() => expect(pressed()).toBe("default"));

  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label=cap]")?.click());

  expect(set).toHaveBeenCalledWith("cap");
  await vi.waitFor(() =>
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Couldn't change the app icon",
    ),
  );
  expect(pressed()).toBe("default");
});
