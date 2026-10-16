// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ArchivedBotList } from "../components/archived-bot-list.ios";
import type { MobileBot, MobileGroup } from "./api";

const swift = vi.hoisted(() => ({
  buttons: [] as Array<{ label?: string; onPress?: () => void }>,
  stacks: [] as Array<Array<{ name: string; value: unknown }>>,
  images: [] as string[],
}));

vi.mock("@expo/ui/swift-ui", () => {
  const wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ContextMenu = Object.assign(wrap, { Trigger: wrap, Items: wrap });
  const SwipeActions = Object.assign(wrap, { Actions: wrap });
  const List = Object.assign(wrap, { ForEach: wrap });
  return {
    Button: (props: { label?: string; onPress?: () => void; children?: ReactNode }) => {
      swift.buttons.push(props);
      return <div>{props.children}</div>;
    },
    ContextMenu,
    Host: wrap,
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
    Section: wrap,
    Spacer: () => null,
    SwipeActions,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return Object.fromEntries(
    [
      "accessibilityElement",
      "accessibilityLabel",
      "buttonStyle",
      "disabled",
      "foregroundStyle",
      "frame",
      "listSectionMargins",
      "listStyle",
    ].map((name) => [name, modifier(name)]),
  );
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "ink" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

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
