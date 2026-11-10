// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupAvatar } from "../components/group-avatar";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("./native", () => ({
  native: { fillPressed: "fill-pressed", secondaryLabel: "secondary-label", label: "label" },
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ identity }: { identity: string }) =>
    createElement("i", { "data-member": identity }),
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ android }: { android: string }) => createElement("i", { "data-icon": android }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const member = (index: number) => ({ botId: `bot-${index}`, color: "#2A92FE" });
const render = (members: ReturnType<typeof member>[]) =>
  act(() => root.render(<GroupAvatar members={members} size={54} />));

describe("mobile group avatar", () => {
  it("uses a native group icon rather than an emoji when members are unavailable", () => {
    render([]);
    expect(container.querySelector('[data-icon="people"]')).not.toBeNull();
    expect(container.textContent).not.toContain("👥");
  });
  it("shows the lone member as their existing bot avatar", () => {
    render([member(0)]);
    expect(container.querySelector('[data-member="bot-0"]')).not.toBeNull();
  });
  it("represents larger rosters with actual members and an overflow count", () => {
    render(Array.from({ length: 6 }, (_, index) => member(index)));
    expect(container.querySelectorAll("[data-member]")).toHaveLength(2);
    expect(container.textContent).toContain("+4");
  });
});
