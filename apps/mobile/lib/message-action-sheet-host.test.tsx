// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AndroidMessageActionSheetHost from "../components/message-action-sheet-compose";
import { MessageActionSheetHost } from "../components/message-action-sheet-host";
import { isComposeViewAvailable } from "./compose-available";
import { presentMessageActionSheet } from "./message-action-sheet";

const native = vi.hoisted(() => ({
  hide: vi.fn(async () => {}),
  host: vi.fn(),
  sheet: vi.fn(),
  box: vi.fn(),
  list: vi.fn(),
  text: vi.fn(),
  row: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));
vi.mock("./compose-available", () => ({ isComposeViewAvailable: vi.fn(() => true) }));
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  clickable: (handler: () => void) => ({ handler }),
  fillMaxWidth: () => ({}),
  padding: (start: number, top: number, end: number, bottom: number) => ({
    padding: { start, top, end, bottom },
  }),
  size: (width: number, height: number) => ({ size: { width, height } }),
  clip: (shape: unknown) => ({ clip: shape }),
  Shapes: { RoundedCorner: (radius: number) => ({ radius }) },
  background: (color: string) => ({ background: color }),
  defaultMinSize: (value: unknown) => ({ defaultMinSize: value }),
  selectable: (selected: boolean, handler: () => void) => ({ selected, handler }),
}));
vi.mock("@expo/ui/jetpack-compose", () => ({
  Host: (props: { children: ReactNode }) => {
    native.host(props);
    return props.children;
  },
  ModalBottomSheet: Object.assign(
    (props: { children: ReactNode; ref: Ref<unknown>; onDismissRequest: () => void }) => {
      native.sheet(props);
      useImperativeHandle(props.ref, () => ({ hide: native.hide }));
      return (
        <div>
          <button type="button" onClick={props.onDismissRequest}>
            Dismiss
          </button>
          {props.children}
        </div>
      );
    },
    {
      DragHandle: ({ children }: { children: ReactNode }) => (
        <div data-handle="true">{children}</div>
      ),
    },
  ),
  Box: (props: { children?: ReactNode }) => {
    native.box(props);
    return props.children;
  },
  LazyColumn: (props: { children: ReactNode }) => {
    native.list(props);
    return <div data-scroll="true">{props.children}</div>;
  },
  Text: (props: { children: ReactNode }) => {
    native.text(props);
    return <span>{props.children}</span>;
  },
  ListItem: Object.assign(
    ({
      children,
      modifiers,
    }: {
      children: ReactNode;
      modifiers: { handler?: () => void; selected?: boolean }[];
    }) => {
      native.row({ modifiers });
      return (
        <button
          type="button"
          data-selected={modifiers.find((modifier) => modifier.selected !== undefined)?.selected}
          onClick={modifiers.find((modifier) => modifier.handler)?.handler}
        >
          {children}
        </button>
      );
    },
    {
      HeadlineContent: ({ children }: { children: ReactNode }) => children,
      TrailingContent: ({ children }: { children: ReactNode }) => (
        <span data-check="true">{children}</span>
      ),
    },
  ),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(isComposeViewAvailable).mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(<AndroidMessageActionSheetHost />);
  });
}

it.each(["light", "dark"] as const)(
  "renders all rows in a scrolling native list with app %s colors",
  async (colorScheme) => {
    await mount();
    const onPress = vi.fn();
    act(() =>
      presentMessageActionSheet({
        actions: Array.from({ length: 100 }, (_, index) => ({ text: `Model ${index}`, onPress })),
        title: "Models",
        selected: 42,
        cancel: "Cancel",
        more: "More",
        colorScheme,
      }),
    );
    expect(container.querySelectorAll("[data-scroll] button")).toHaveLength(100);
    expect(container.textContent).toContain("Models");
    const tokens = tokensForAppearance(colorScheme);
    expect(native.host.mock.lastCall?.[0]).toMatchObject({
      colorScheme,
      seedColor: tokens.primary,
    });
    expect(native.sheet.mock.lastCall?.[0]).toMatchObject({
      containerColor: tokens.card,
      contentColor: tokens.foreground,
      scrimColor: tokens.overlay,
    });
    const rows = container.querySelectorAll("[data-scroll] button");
    expect(rows[42]?.getAttribute("data-selected")).toBe("true");
    expect(rows[41]?.getAttribute("data-selected")).toBe("false");
    expect(rows[42]?.querySelector("[data-check]")?.textContent).toBe("✓");
    expect(container.querySelectorAll("[data-check]")).toHaveLength(1);
    expect(
      native.text.mock.calls.some(
        ([props]) => props.children === "✓" && props.color === tokens.primary,
      ),
    ).toBe(true);
    expect(
      native.box.mock.calls.some(([props]) =>
        props.modifiers.some(
          (modifier: { background?: string }) => modifier.background === tokens.mutedForeground,
        ),
      ),
    ).toBe(true);
    expect(native.list.mock.lastCall?.[0]).toMatchObject({ contentPadding: { bottom: 24 } });
    expect(native.row.mock.calls[42]?.[0].modifiers).toEqual(
      expect.arrayContaining([{ defaultMinSize: { minHeight: 56 } }]),
    );
    for (const [row] of native.row.mock.calls) {
      expect(row.modifiers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ semantics: expect.anything() })]),
      );
    }
    expect(
      native.text.mock.calls.find(([props]) => props.children === "Models")?.[0],
    ).toMatchObject({
      style: { typography: "titleMedium" },
      modifiers: [{ padding: { start: 16, top: 8, end: 16, bottom: 20 } }],
    });
    expect(
      native.text.mock.calls.find(([props]) => props.children === "Model 42")?.[0],
    ).toMatchObject({
      style: { typography: "bodyLarge" },
    });
    await act(async () => {
      (container.querySelectorAll("[data-scroll] button")[99] as HTMLButtonElement).click();
    });
    expect(native.hide).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  },
);

it("routes native gesture, scrim and Back dismissal to cancellation", async () => {
  await mount();
  const onPress = vi.fn();
  act(() =>
    presentMessageActionSheet({
      actions: [{ text: "React", onPress }],
      cancel: "Cancel",
      more: "More",
      colorScheme: "light",
    }),
  );
  expect(container.querySelector("[data-check]")).toBeNull();
  expect(container.querySelector("[data-scroll] button")?.hasAttribute("data-selected")).toBe(
    false,
  );
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toBe("");
  expect(onPress).not.toHaveBeenCalled();
});

it("does not render the Compose host when a required native view is missing", async () => {
  vi.mocked(isComposeViewAvailable).mockReturnValue(false);
  await act(async () => {
    root.render(<MessageActionSheetHost />);
  });
  expect(native.host).not.toHaveBeenCalled();
  expect(native.sheet).not.toHaveBeenCalled();
});
