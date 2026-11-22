// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { previewListCollapsed, setListCollapsed } = vi.hoisted(() => ({
  previewListCollapsed: vi.fn(),
  setListCollapsed: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../../../lib/platform/use-desktop-badge", () => ({
  useDesktopBadge: () => undefined,
}));
vi.mock("../app-rail", () => ({
  useAppSidebar: () => ({
    listCollapsed: false,
    setListCollapsed,
    previewListCollapsed,
  }),
}));

import { useSidebarView } from "./use-sidebar-view";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let view: ReturnType<typeof useSidebarView>;

function Probe() {
  view = useSidebarView({
    userId: "user",
    isMobile: false,
    bootstrapMe: null,
    spaces: [],
    bots: [],
    groups: [],
    botSections: [],
    searchQuery: "",
    now: 0,
  });
  return null;
}

beforeEach(() => {
  previewListCollapsed.mockClear();
  setListCollapsed.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("previews a drag without saving it and commits through the preference setter", async () => {
  await act(async () => root.render(<Probe />));

  view.previewCollapsed(true);
  expect(previewListCollapsed).toHaveBeenCalledWith(true);
  expect(setListCollapsed).not.toHaveBeenCalled();

  view.setCollapsedPref(true);
  expect(setListCollapsed).toHaveBeenCalledWith(true);
});
