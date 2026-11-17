// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 12, right: 72 }),
}));

const { InboxBesideContext, useSideInsets } = await import("./side-insets");

async function sideInsets(besideInbox?: boolean) {
  let value: ReturnType<typeof useSideInsets> | undefined;
  function Probe() {
    value = useSideInsets();
    return null;
  }
  const probe = createElement(Probe);
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      besideInbox === undefined
        ? probe
        : createElement(InboxBesideContext.Provider, { value: besideInbox }, probe),
    ),
  );
  await act(async () => root.unmount());
  return value;
}

it("keeps content clear of a side status bar and the far cutout", async () => {
  expect(await sideInsets()).toEqual({ paddingLeft: 12, paddingRight: 72 });
  expect(await sideInsets(false)).toEqual({ paddingLeft: 12, paddingRight: 72 });
});

it("leaves the left edge to the chat list beside the screen", async () => {
  expect(await sideInsets(true)).toEqual({ paddingLeft: 0, paddingRight: 72 });
});
