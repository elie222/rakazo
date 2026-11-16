// @vitest-environment jsdom
import type { PageDetail } from "@rakazo/contracts";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { useChatOnScreen, usePageCardDetail } from "./page-card-detail";

const screen = vi.hoisted(() => ({ refocus: () => {} }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => {
    screen.refocus = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));

function Card({ id }: { id: string }) {
  const detail = usePageCardDetail({ pageId: "p9", version: 1 });
  return createElement("p", { id }, typeof detail === "object" && detail ? detail.title : "");
}
function Chat({ cards }: { cards: string[] }) {
  useChatOnScreen();
  return createElement("div", {}, ...cards.map((id) => createElement(Card, { key: id, id })));
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("reads a card's page once, again only after the chat comes back on screen", async () => {
  const read = vi.mocked(rpc);
  const named = (title: string) => ({ id: "p9", currentVersion: 1, title }) as PageDetail;
  read.mockResolvedValue(named("Old") as never);
  await act(async () => root.render(createElement(Chat, { cards: ["a", "b"] })));
  expect(container.textContent).toBe("OldOld");
  expect(read).toHaveBeenCalledTimes(1);

  // Scrolling a card out and back in mounts it again; it must not read the page again.
  await act(async () => root.render(createElement(Chat, { cards: ["a"] })));
  await act(async () => root.render(createElement(Chat, { cards: ["a", "c"] })));
  expect(read).toHaveBeenCalledTimes(1);

  // Back from another screen: a rename made elsewhere shows, read once for every card.
  read.mockResolvedValue(named("Renamed on desktop") as never);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    screen.refocus();
  });
  expect(container.textContent).toBe("Renamed on desktopRenamed on desktop");
  expect(read).toHaveBeenCalledTimes(2);
});
