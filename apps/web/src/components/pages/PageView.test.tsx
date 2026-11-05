// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageView } from "./PageView";

const frame = vi.hoisted(() => ({ drawn: undefined as (() => void) | undefined }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PageFrame", () => ({
  PageFrame: ({ onHeight }: { onHeight: () => void }) => {
    frame.drawn = onHeight;
    return <iframe title="page" />;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(props: { document: string; onOpenChange?: (open: boolean) => void }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (next: typeof props) =>
    act(async () =>
      root.render(
        <PageView
          open
          onOpenChange={next.onOpenChange ?? (() => {})}
          title="Plan"
          document={next.document}
          share={<button type="button">Share</button>}
        />,
      ),
    );
  return { render, unmount: () => act(() => root.unmount()) };
}

it("waits for an updated page to draw, and offers a retry when it never does", async () => {
  vi.useFakeTimers();
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  await act(async () => frame.drawn?.());
  expect(document.body.textContent).not.toContain("This page couldn't load");

  await view.render({ document: "<p>v2</p>" });
  await act(async () => vi.advanceTimersByTime(16_000));
  expect(document.body.textContent).toContain("This page couldn't load");
  await view.unmount();
});

it("closes on Escape unless the key landed in a popup", async () => {
  const onOpenChange = vi.fn();
  const view = mount({ document: "<p>v1</p>", onOpenChange });
  await view.render({ document: "<p>v1</p>", onOpenChange });
  // A menu elsewhere in the app, open but not where the key went.
  const menu = document.body.appendChild(document.createElement("div"));
  menu.dataset.slot = "dropdown-menu-content";
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  await press(document.querySelector('[data-testid="page-view"]')!);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  onOpenChange.mockClear();
  const item = menu.appendChild(document.createElement("button"));
  await press(item);
  expect(onOpenChange).not.toHaveBeenCalled();
  await view.unmount();
});
