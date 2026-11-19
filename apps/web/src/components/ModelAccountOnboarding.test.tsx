// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../pages/model-account/AccountI18n", () => ({
  AccountI18n: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({ rpc: { me: vi.fn() } }));
vi.mock("../pages/model-account/ModelAccountSettings", () => ({
  ModelAccountSettings: ({
    onClose,
    embedded,
    onModelsChanged,
  }: {
    onClose: () => void;
    embedded?: boolean;
    onModelsChanged?: () => void;
  }) => (
    <button type="button" onClick={embedded ? onModelsChanged : onClose}>
      {embedded ? "Choose model" : "Close settings"}
    </button>
  ),
}));

import { rpc } from "../lib/query/rpc";
import { ModelAccountOnboarding } from "./ModelAccountOnboarding";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function Location() {
  return <output>{useLocation().search}</output>;
}

it.each([true, false])(
  "restores settings after a redirect and checks needsModel=%s on close",
  async (needsModel) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(rpc.me).mockResolvedValue({ needsModel } as Awaited<ReturnType<typeof rpc.me>>);
    const onReady = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={["/onboarding/model?modelAccountError=unavailable"]}>
            <ModelAccountOnboarding enabled onReady={onReady} />
            <Location />
          </MemoryRouter>,
        ),
      );
      const close = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Close settings",
      );
      expect(close).toBeDefined();
      await act(async () => close?.click());
      expect(host.querySelector("output")?.textContent).toBe(
        "?modelAccountError=unavailable&settings=closed",
      );
      expect(onReady).toHaveBeenCalledTimes(needsModel ? 0 : 1);
      if (needsModel) {
        const choose = Array.from(host.querySelectorAll("button")).find(
          (button) => button.textContent === "Choose model",
        );
        expect(choose).toBeDefined();
        expect(host.textContent).not.toContain("Close settings");
        vi.mocked(rpc.me).mockResolvedValue({ needsModel: false } as Awaited<
          ReturnType<typeof rpc.me>
        >);
        await act(async () => choose?.click());
        expect(onReady).toHaveBeenCalledOnce();
      } else {
        const open = Array.from(host.querySelectorAll("button")).find(
          (button) => button.textContent === "Model account",
        );
        await act(async () => open?.click());
        expect(host.querySelector("output")?.textContent).toBe(
          "?modelAccountError=unavailable&settings=models",
        );
        expect(host.textContent).toContain("Close settings");
      }
    } finally {
      act(() => root.unmount());
    }
  },
);
