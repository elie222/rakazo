// @vitest-environment jsdom

import type { MenuComponentProps, MenuComponentRef } from "@expo/ui/community/menu";
import type { Ticket } from "@rakazo/contracts";
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardList } from "./board-list";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    children,
    onPressAction,
    ref,
  }: MenuComponentProps & { ref?: Ref<MenuComponentRef> }) => {
    const [open, setOpen] = useState(false);
    useImperativeHandle(ref, () => ({ show: () => setOpen(true) }));
    return (
      <div>
        {children}
        {open ? (
          <div role="menu">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPressAction?.({ nativeEvent: { event: action.id ?? action.title } });
                }}
              >
                {action.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: ({
    children,
    accessibilityRole,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    onPress?: () => void;
  }) => (
    <button type="button" role={accessibilityRole} onClick={onPress}>
      {children}
    </button>
  ),
  RefreshControl: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: () => null,
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../appearance/ripple", () => ({ androidRipple: () => undefined }));
vi.mock("../native/native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../../components/native/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../../components/ui/row-accessories", () => ({ Chevron: () => null }));

it("lets the Android ticket button open its menu without moving until a status is selected", async () => {
  const first = { id: "fixture-1", ref: "RZ-1", title: "First ticket", status: "todo" } as Ticket;
  const second = { id: "fixture-2", ref: "RZ-2", title: "Second ticket", status: "todo" } as Ticket;
  const onMove = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);

  try {
    await act(async () =>
      root.render(
        <BoardList
          sections={[{ status: "todo", tickets: [first, second] }]}
          error=""
          refreshFailures={0}
          onMove={onMove}
          onRefresh={onRefresh}
        />,
      ),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[role="button"]')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "First ticketRZ-1",
      "Second ticketRZ-2",
    ]);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await act(async () => buttons[1]?.click());
    expect(onMove).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[role="menu"]')).toHaveLength(1);
    const choices = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(choices.map((choice) => choice.textContent)).not.toContain("To do");
    const doing = choices.find((choice) => choice.textContent === "In progress");
    expect(doing).toBeDefined();
    await act(async () => doing?.click());
    expect(onMove).toHaveBeenCalledExactlyOnceWith(second, "doing");
    expect(onRefresh).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
