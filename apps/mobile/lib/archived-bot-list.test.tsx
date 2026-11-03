// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ArchivedBotList } from "../components/archived-bot-list.ios";
import type { MobileBot, MobileGroup } from "./api";

const swift = vi.hoisted(() => ({
  buttons: [] as Array<{
    label?: string;
    role?: string;
    onPress?: () => void;
    modifiers?: Array<{ name: string; value: unknown }>;
  }>,
  stacks: [] as Array<Array<{ name: string; value: unknown }>>,
  hosts: [] as Array<{ ignoreSafeArea?: string }>,
  lists: [] as Array<Array<{ name: string; value: unknown }>>,
  sectionHeaders: [] as unknown[],
  spacers: [] as Array<Array<{ name: string; value: unknown }>>,
  menus: [] as Array<Array<{ name: string; value: unknown }>>,
  headerInset: 0,
  images: [] as string[],
}));

vi.mock("@expo/ui/swift-ui", () => {
  const wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ContextMenu = Object.assign(
    ({
      children,
      modifiers,
    }: {
      children?: ReactNode;
      modifiers?: Array<{ name: string; value: unknown }>;
    }) => {
      swift.menus.push(modifiers ?? []);
      return <div>{children}</div>;
    },
    { Trigger: wrap, Items: wrap },
  );
  const SwipeActions = Object.assign(wrap, { Actions: wrap });
  const List = Object.assign(
    ({
      children,
      modifiers,
    }: {
      children?: ReactNode;
      modifiers?: Array<{ name: string; value: unknown }>;
    }) => {
      swift.lists.push(modifiers ?? []);
      return <div>{children}</div>;
    },
    { ForEach: wrap },
  );
  return {
    Button: (props: {
      label?: string;
      role?: string;
      onPress?: () => void;
      modifiers?: Array<{ name: string; value: unknown }>;
      children?: ReactNode;
    }) => {
      swift.buttons.push(props);
      return <div>{props.children}</div>;
    },
    ContextMenu,
    Host: ({ children, ignoreSafeArea }: { children?: ReactNode; ignoreSafeArea?: string }) => {
      swift.hosts.push({ ignoreSafeArea });
      return <div>{children}</div>;
    },
    HStack: ({
      children,
      modifiers,
    }: {
      children?: ReactNode;
      modifiers?: Array<{ name: string; value: unknown }>;
    }) => {
      swift.stacks.push(modifiers ?? []);
      return <div>{children}</div>;
    },
    Image: ({ systemName }: { systemName: string }) => {
      swift.images.push(systemName);
      return null;
    },
    List,
    Section: ({ children, header }: { children?: ReactNode; header?: ReactNode }) => {
      swift.sectionHeaders.push(header);
      return (
        <div>
          {header}
          {children}
        </div>
      );
    },
    Spacer: ({ modifiers }: { modifiers?: Array<{ name: string; value: unknown }> }) => {
      swift.spacers.push(modifiers ?? []);
      return null;
    },
    SwipeActions,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  const modifiers = Object.fromEntries(
    [
      "accessibilityElement",
      "accessibilityLabel",
      "buttonStyle",
      "contentShape",
      "disabled",
      "foregroundStyle",
      "frame",
      "listRowInsets",
      "listSectionMargins",
      "listStyle",
      "tint",
    ].map((name) => [name, modifier(name)]),
  );
  return {
    ...modifiers,
    shapes: { rectangle: () => ({ shape: "rectangle" }) },
  };
});
vi.mock("react-native", () => ({ PlatformColor: (name: string) => ({ semantic: [name] }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "ink" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => swift.headerInset }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

it("gives archived bot and group rows a rectangular context-menu hit area", () => {
  swift.menus.length = 0;
  renderToStaticMarkup(
    <ArchivedBotList
      bots={[{ id: "b", name: "Ada" } as MobileBot]}
      groups={[{ id: "g", name: "Crew" } as MobileGroup]}
      pending={false}
      onOpen={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onRestoreGroup={vi.fn()}
    />,
  );
  const rectangle = [{ name: "contentShape", value: { shape: "rectangle" } }];
  expect(swift.menus).toEqual([rectangle, rectangle]);
});

it("lists archived groups after bots with a group symbol, name and Restore only", () => {
  const onRestoreGroup = vi.fn();
  const html = renderToStaticMarkup(
    <ArchivedBotList
      bots={[{ id: "b", name: "Ada" } as MobileBot]}
      groups={[{ id: "g", name: "Crew" } as MobileGroup]}
      pending={false}
      onOpen={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onRestoreGroup={onRestoreGroup}
    />,
  );
  expect(html.indexOf("Ada")).toBeLessThan(html.indexOf("Crew"));
  expect(swift.images).toContain("person.2");
  expect(swift.stacks).toContainEqual([
    { name: "accessibilityElement", value: "ignore" },
    { name: "accessibilityLabel", value: "Crew, Group" },
  ]);
  const groupButtons = swift.buttons.slice(-2);
  expect(groupButtons.map((button) => button.label)).toEqual(["Restore", "Restore"]);
  groupButtons[0]!.onPress!();
  expect(onRestoreGroup).toHaveBeenCalledWith({ id: "g", name: "Crew" });
});

it("fills the swipe buttons so their white labels show in dark mode too", () => {
  swift.buttons.length = 0;
  renderToStaticMarkup(
    <ArchivedBotList
      bots={[{ id: "b", name: "Ada" } as MobileBot]}
      groups={[{ id: "g", name: "Test" } as MobileGroup]}
      pending={false}
      onOpen={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onRestoreGroup={vi.fn()}
    />,
  );
  const restores = swift.buttons.filter((button) => button.label === "Restore");
  // Bot menu, bot swipe, group menu, group swipe: only the swipe buttons get a fill.
  expect(restores.map((button) => button.modifiers ?? [])).toEqual([
    [],
    [{ name: "tint", value: { semantic: ["systemBlue"] } }],
    [],
    [{ name: "tint", value: { semantic: ["systemBlue"] } }],
  ]);
  // The host tint also overrides Delete's destructive red, so the swipe Delete gets red back.
  const deletes = swift.buttons.filter((button) => button.label === "Delete");
  expect(deletes.map((button) => button.modifiers ?? [])).toEqual([
    [],
    [{ name: "tint", value: { semantic: ["systemRed"] } }],
  ]);
});

it("keeps a cancelled swipe Delete from hiding the row", () => {
  swift.buttons.length = 0;
  renderToStaticMarkup(
    <ArchivedBotList
      bots={[{ id: "b", name: "Ada" } as MobileBot]}
      groups={[]}
      pending={false}
      onOpen={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onRestoreGroup={vi.fn()}
    />,
  );
  // SwiftUI drops a row when a destructive swipe button is tapped, before the confirmation;
  // only the menu's Delete keeps the role.
  const deletes = swift.buttons.filter((button) => button.label === "Delete");
  expect(deletes.map((button) => button.role)).toEqual(["destructive", undefined]);
});

it("starts the list below the floating header from its measured height, not the host's safe area", () => {
  const render = () =>
    renderToStaticMarkup(
      <ArchivedBotList
        bots={[]}
        groups={[{ id: "g", name: "Test" } as MobileGroup]}
        pending={false}
        onOpen={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        onRestoreGroup={vi.fn()}
      />,
    );
  const headerSpacer = () =>
    swift.spacers.find((modifiers) =>
      modifiers.some(
        (modifier) =>
          modifier.name === "frame" && (modifier.value as { height?: number }).height === 64,
      ),
    );
  swift.headerInset = 64;
  swift.hosts.length = 0;
  swift.lists.length = 0;
  swift.sectionHeaders.length = 0;
  swift.spacers.length = 0;
  render();
  expect(swift.hosts.at(-1)).toEqual({ ignoreSafeArea: "container" });
  // The inset sits inside the scroll content, so rows still scroll under the floating header.
  expect(swift.lists.at(-1)?.some((modifier) => modifier.name === "padding")).toBe(false);
  expect(swift.sectionHeaders.at(-1)).toBeDefined();
  expect(headerSpacer()).toContainEqual({
    name: "listRowInsets",
    value: { top: 0, leading: 0, bottom: 0, trailing: 0 },
  });
  // Without a floating header (older iOS) the system safe area still applies.
  swift.headerInset = 0;
  swift.spacers.length = 0;
  render();
  expect(swift.hosts.at(-1)).toEqual({ ignoreSafeArea: undefined });
  expect(swift.sectionHeaders.at(-1)).toBeUndefined();
  expect(headerSpacer()).toBeUndefined();
});
