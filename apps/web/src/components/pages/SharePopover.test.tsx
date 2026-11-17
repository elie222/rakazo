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

it("says under a choice only what its title does not", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const show = (visibility: "private" | "space" | "link" | null) =>
    act(async () =>
      root.render(
        <SharePopover
          title="Plan"
          owner={{ name: "RJ", image: null }}
          visibility={visibility}
          shareUrl={visibility === "link" ? "https://rakazo.example/p/1" : null}
          open
          onOpenChange={() => {}}
          onVisibilityChange={() => {}}
        />,
      ),
    );
  const choices = () =>
    [...document.querySelectorAll('[role="radiogroup"] label')].map((label) => label.textContent);
  await show("private");
  expect(choices()).toEqual([
    "Only you",
    "Your Space",
    "Anyone with the linkCan view without signing in",
  ]);
  // Sharing with the Space leaves no link to warn about.
  await show("space");
  expect(choices()).toEqual([
    "Only you",
    "Your Space",
    "Anyone with the linkCan view without signing in",
  ]);
  // Turning the link off, or narrowing it to the Space, warns what that does to its holders.
  const warned = [
    "Only youThe shared link stops working",
    "Your SpaceThe shared link stops working",
    "Anyone with the linkCan view without signing in",
  ];
  await show("link");
  expect(choices()).toEqual(warned);
  // After a lost answer the link may be live, so either choice warns.
  await show(null);
  expect(choices()).toEqual(warned);
  await act(async () => root.unmount());
});
