// @vitest-environment jsdom
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LongPressMenu } from "../components/long-press-menu";

const state = vi.hoisted(() => ({ os: "android", show: vi.fn() }));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    ref,
    shouldOpenOnLongPress,
    children,
  }: {
    ref: Ref<{ show: () => void }>;
    shouldOpenOnLongPress?: boolean;
    children: ReactNode;
  }) => {
    useImperativeHandle(ref, () => ({ show: state.show }));
    return <div data-long-press={String(shouldOpenOnLongPress)}>{children}</div>;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;

afterEach(() => {
  container?.remove();
  state.show.mockReset();
});

function render() {
  let onLongPress: (() => void) | undefined;
  container = document.createElement("div");
  document.body.append(container);
  act(() =>
    createRoot(container).render(
      <LongPressMenu actions={[]} onPressAction={() => {}}>
        {(handler) => {
          onLongPress = handler;
          return <span />;
        }}
      </LongPressMenu>,
    ),
  );
  return onLongPress;
}

it("lets an Android row open the menu, since the row claims the long press", () => {
  state.os = "android";
  const onLongPress = render();
  expect(container.querySelector("[data-long-press]")?.getAttribute("data-long-press")).toBe(
    "true",
  );
  onLongPress?.();
  expect(state.show).toHaveBeenCalledOnce();
});

it("leaves iOS rows to the native context menu", () => {
  state.os = "ios";
  expect(render()).toBeUndefined();
});
