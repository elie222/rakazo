// @vitest-environment jsdom
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AccessibilityActionEvent, ViewProps } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileGroup } from "../../lib/api/mobile-types";
import { ArchivedBotList } from "./archived-bot-list";

vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    ref,
    actions,
    onPressAction,
    children,
  }: {
    ref?: Ref<{ show: () => void }>;
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) => {
    const [open, setOpen] = useState(false);
    const show = () => setOpen(true);
    useImperativeHandle(ref, () => ({ show }));
    return (
      <>
        <div onPointerDown={show} data-menu-trigger>
          {children}
        </div>
        {open ? (
          <div role="menu">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={action.attributes?.disabled}
                onClick={() => {
                  onPressAction({ nativeEvent: { event: action.id } });
                  setOpen(false);
                }}
              >
                {action.title}
              </button>
            ))}
          </div>
        ) : null}
      </>
    );
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  ScrollView: ({ children }: ViewProps) => <div>{children}</div>,
  View: ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityActions,
    onAccessibilityAction,
  }: ViewProps) => {
    if (accessibilityRole !== "button") {
      return accessibilityLabel ? (
        <fieldset aria-label={accessibilityLabel}>{children}</fieldset>
      ) : (
        <div>{children}</div>
      );
    }
    return (
      <button
        type="button"
        aria-label={accessibilityLabel}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            !accessibilityActions?.some(({ name }) => name === "activate")
          )
            return;
          onAccessibilityAction?.({
            nativeEvent: { actionName: "activate" },
          } as AccessibilityActionEvent);
        }}
      >
        {children}
      </button>
    );
  },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../lib/layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../../lib/native/native", () => ({ native: {}, useResolvedAppearance: () => "light" }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../ui/long-press-menu", () => ({ LongPressMenu: () => null }));
vi.mock("../ui/row-accessories", () => ({ Chevron: () => null }));

const groups = [
  { id: "first", name: "Research" },
  { id: "second", name: "Travel" },
] as MobileGroup[];
const onRestoreGroup = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onRestoreGroup.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render() {
  return act(async () =>
    root.render(
      <ArchivedBotList
        bots={[]}
        groups={groups}
        pending={false}
        onOpen={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        onRestoreGroup={onRestoreGroup}
      />,
    ),
  );
}

function button(name: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${name}, Group"]`);
}

it("opens only the named group's menu through accessibility activation before restoring", async () => {
  await render();
  expect(button("Research")).not.toBeNull();
  const second = button("Travel");
  expect(second).not.toBeNull();
  await act(async () =>
    second!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onRestoreGroup).not.toHaveBeenCalled();
  const restore = host.querySelector<HTMLButtonElement>('[role="menuitem"]');
  expect(restore?.textContent).toBe("Restore");
  await act(async () => restore!.click());
  expect(onRestoreGroup).toHaveBeenCalledExactlyOnceWith(groups[1]);
});
