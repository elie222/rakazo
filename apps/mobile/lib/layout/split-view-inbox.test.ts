// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { FoldRegion } from "./fold-regions";

let folds: FoldRegion[] = [];
vi.mock("./fold-regions", () => ({ useFoldRegions: () => folds }));
vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 951, height: 669 }) }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));

const { setInboxHidden, useSplitView } = await import("./split-view");

async function splitView() {
  let view: ReturnType<typeof useSplitView> | undefined;
  function Probe() {
    view = useSplitView();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  if (!view) throw new Error("useSplitView did not render");
  return view;
}

it("keeps a hidden chat list beside the chat while folded like a book", async () => {
  setInboxHidden(true);

  folds = [];
  const flat = await splitView();
  expect(flat).toMatchObject({ inboxHidden: true, inboxShown: false, contentWidth: 951 });

  folds = [{ x: 465, y: 0, width: 21, height: 669 }];
  const folded = await splitView();
  expect(folded).toMatchObject({ inboxHidden: true, inboxShown: true, foldActive: true });
  expect(folded.contentWidth).toBe(951 - 465 - 21);

  setInboxHidden(false);
  folds = [];
});
