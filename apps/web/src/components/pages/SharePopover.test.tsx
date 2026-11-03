// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SharePopover } from "./SharePopover";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("names an unnamed owner You, and starts an initial at a letter rather than an emoji", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const show = (name: string) =>
    act(async () =>
      root.render(
        <SharePopover
          title="Plan"
          owner={{ name, image: null }}
          visibility="private"
          shareUrl={null}
          open
          onOpenChange={() => {}}
          onVisibilityChange={() => {}}
        />,
      ),
    );
  const owner = () => document.querySelector('[data-testid="page-share"]')?.textContent ?? "";
  await show("");
  expect(owner()).toContain("YYouOwner");
  await show("🦊 kit");
  expect(owner()).toContain("K🦊 kitOwner");
  await act(async () => root.unmount());
});
