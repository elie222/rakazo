// @vitest-environment jsdom

import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewGroup from "../app/new-group";
import type { MobileBot } from "./api";

const {
  rpc,
  back,
  push,
  replace,
  announce,
  hardwareBack,
  nativeHeader,
  addToSearchInbox,
  groupPreview,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  groupPreview: vi.fn(),
  addToSearchInbox: vi.fn(),
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  announce: vi.fn(),
  hardwareBack: { current: undefined as (() => boolean) | undefined },
  nativeHeader: { current: false },
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({ rpc }));
vi.mock("./search-inbox", () => ({
  addToSearchInbox,
  searchInboxSession: () => ({ generation: 4, apiBase: "http://api.test" }),
}));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 56 }));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({
      options,
    }: {
      options: {
        headerLeft: () => ReactNode;
        headerRight: () => ReactNode;
        unstable_headerLeftItems?: () => {
          label: string;
          disabled?: boolean;
          onPress: () => void;
        }[];
        unstable_headerRightItems?: () => {
          label: string;
          disabled?: boolean;
          onPress: () => void;
        }[];
      };
    }) => (
      <header>
        {nativeHeader.current
          ? options.unstable_headerLeftItems?.().map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={item.onPress}
              >
                {item.label}
              </button>
            ))
          : options.headerLeft()}
        {nativeHeader.current
          ? options.unstable_headerRightItems?.().map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={item.onPress}
              >
                {item.label}
              </button>
            ))
          : options.headerRight()}
      </header>
    ),
  },
  useRouter: () => ({ back, push, replace, canDismiss: () => false, canGoBack: () => false }),
  useLocalSearchParams: () => ({ groupId: "group-1" }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    AccessibilityInfo: { announceForAccessibility: announce },
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        hardwareBack.current = handler;
        return {
          remove: () => {
            hardwareBack.current = undefined;
          },
        };
      },
    },
    View,
    ScrollView: View,
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
        {children}
      </button>
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
      onKeyPress,
      onSubmitEditing,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
      onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
      onSubmitEditing?: () => void;
      editable?: boolean;
    }) => (
      <input
        value={value}
        disabled={editable === false}
        onKeyDown={(event) => {
          onKeyPress?.({ nativeEvent: { key: event.key } });
          if (event.key === "Enter") onSubmitEditing?.();
        }}
        onChange={(event) => onChangeText(event.target.value)}
        aria-label={accessibilityLabel}
        placeholder={placeholder}
      />
    ),
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({
    t: (text: string, values: Record<string, string | number> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
  }),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => nativeHeader.current }));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("../components/sheet-close-button", () => ({
  SheetCloseButton: ({ onPress }: { onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      Close
    </button>
  ),
}));
vi.mock("../components/group-avatar", () => ({
  GroupAvatar: (props: unknown) => {
    groupPreview(props);
    return null;
  },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
const bots = [
  { id: "bot-1", name: "Researcher" },
  { id: "bot-2", name: "Writer" },
  { id: "bot-3", name: "Support" },
] as MobileBot[];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  nativeHeader.current = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "bots/list" ? bots : { id: "group-1", name: "Created" },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
}
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
}
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function start() {
  await act(async () => root.render(<NewGroup />));
}
async function pickPair() {
  await click("Writer");
  await click("Researcher");
  await click("Next");
}

it("keeps each selected bot's icon set in the name-step group preview", async () => {
  const looks = bots.map((bot, index) => ({
    ...bot,
    color: index === 0 ? "#10B981" : "#8B5CF6",
    avatarSet: index === 0 ? "rakazo" : "organic",
  }));
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "bots/list" ? looks : { id: "group-1", name: "Created" },
  );
  await start();
  await pickPair();
  expect(groupPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      members: [
        { botId: "bot-2", color: "#8B5CF6", avatarSet: "organic" },
        { botId: "bot-1", color: "#10B981", avatarSet: "rakazo" },
      ],
    }),
  );
});

it("adds and removes chips, hides picked and archived bots, and clears filters on pick", async () => {
  rpc.mockResolvedValue([
    ...bots,
    { ...bots[0], id: "archived", name: "Archived", archivedAt: "date" },
  ]);
  await start();
  expect(button("Archived")).toBeUndefined();
  await type("  WRIT ");
  expect(button("Researcher")).toBeUndefined();
  await click("Writer");
  expect(button("Writer")).toBeUndefined();
  expect(button("Researcher")).toBeDefined();
  expect(container.querySelector("input")?.value).toBe("");
  expect(container.querySelector("input")?.placeholder).toBe("Add another");
  await click("Remove Writer");
  expect(button("Writer")).toBeDefined();
  expect(container.querySelector("input")?.placeholder).toBe("Search bots");
  await type("research");
  expect(button("Researcher")).toBeDefined();
  expect(button("Support")).toBeUndefined();
  await type("no match");
  expect(button("Researcher")).toBeUndefined();
});
it("backspace only removes the last chip when the query is empty", async () => {
  await start();
  await click("Researcher");
  await click("Writer");
  await type("x");
  const key = async () =>
    act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
  await key();
  expect(button("Remove Writer")).toBeDefined();
  await type("");
  await key();
  expect(button("Remove Writer")).toBeUndefined();
  expect(button("Remove Researcher")).toBeDefined();
});
it.each([false, true])("disables Next below two picks (native header: %s)", async (native) => {
  nativeHeader.current = native;
  await start();
  expect(button("Next")?.disabled).toBe(true);
  await click("Researcher");
  expect(button("Next")?.disabled).toBe(true);
  await click("Next");
  expect(button("Skip")).toBeUndefined();
  await click("Writer");
  expect(button("Next")?.disabled).toBe(false);
  await click("Next");
  expect(button("Next")).toBeUndefined();
  expect(button("Skip")).toBeDefined();
});
it("enforces ten picks with only an accessibility announcement and permits removal", async () => {
  rpc.mockResolvedValue(
    Array.from({ length: GROUP_MEMBER_MAX + 1 }, (_, i) => ({
      ...bots[0],
      id: `bot-${i}`,
      name: `Bot ${i}`,
    })),
  );
  await start();
  for (let i = 0; i < GROUP_MEMBER_MAX; i++) await click(`Bot ${i}`);
  await click("Bot 10");
  expect(announce).toHaveBeenCalledOnce();
  expect(button("Remove Bot 10")).toBeUndefined();
  await click("Remove Bot 0");
  await click("Bot 10");
  expect(button("Remove Bot 10")).toBeDefined();
});
it("Skip posts the default name in pick order and routes to the group", async () => {
  await start();
  await pickPair();
  await click("Skip");
  expect(rpc).toHaveBeenCalledWith("groups/create", {
    name: "Writer, Researcher",
    botIds: ["bot-2", "bot-1"],
  });
  // The new chat's title seats the members before the inbox lists the group.
  // Only into the session the group was created in.
  expect(addToSearchInbox).toHaveBeenCalledWith(
    { kind: "group", group: { id: "group-1", name: "Created" } },
    { generation: 4, apiBase: "http://api.test" },
  );
  expect(replace).toHaveBeenCalledWith({
    pathname: "/group-thread",
    params: { groupId: "group-1", name: "Created" },
  });
});
it("Create posts a trimmed name with the keyboard done action", async () => {
  await start();
  await pickPair();
  await type("  Project Falcon  ");
  expect(button("Skip")).toBeUndefined();
  expect(button("Create")).toBeDefined();
  await act(async () => {
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(rpc).toHaveBeenCalledWith("groups/create", {
    name: "Project Falcon",
    botIds: ["bot-2", "bot-1"],
  });
});
it.each([false, true])("back keeps picks (hardware: %s)", async (hardware) => {
  await start();
  await pickPair();
  if (hardware)
    await act(async () => {
      expect(hardwareBack.current?.()).toBe(true);
    });
  else await click("Back");
  expect(button("Remove Writer")).toBeDefined();
  expect(button("Remove Researcher")).toBeDefined();
  expect(button("Next")?.disabled).toBe(false);
  expect(back).not.toHaveBeenCalled();
  expect(hardwareBack.current).toBeUndefined();
});
it("disables submission while pending and shows errors inline for retry", async () => {
  let reject!: (reason: Error) => void;
  rpc.mockImplementation(async (procedure: string) =>
    procedure === "bots/list"
      ? bots
      : new Promise((_resolve, fail) => {
          reject = fail;
        }),
  );
  await start();
  await pickPair();
  await click("Skip");
  expect(button("Creating…")?.disabled).toBe(true);
  await act(async () => reject(new Error("Could not create group")));
  expect(container.textContent).toContain("Could not create group");
  expect(button("Skip")?.disabled).toBe(false);
});
it.each(["header", "native header", "hardware"])(
  "blocks %s back while creating and allows it after failure",
  async (control) => {
    nativeHeader.current = control === "native header";
    let reject!: (reason: Error) => void;
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "bots/list"
        ? bots
        : new Promise((_resolve, fail) => {
            reject = fail;
          }),
    );
    await start();
    await pickPair();
    await click("Skip");
    const pressBack = async () => {
      if (control === "hardware") {
        await act(async () => {
          expect(hardwareBack.current?.()).toBe(true);
        });
      } else await click("Back");
    };
    await pressBack();
    expect(button("Creating…")?.disabled).toBe(true);
    expect(button("Next")).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("groups/create", {
      name: "Writer, Researcher",
      botIds: ["bot-2", "bot-1"],
    });
    await act(async () => reject(new Error("Could not create group")));
    await pressBack();
    expect(button("Remove Writer")).toBeDefined();
    expect(button("Remove Researcher")).toBeDefined();
  },
);
it("closes a standalone deep link to home", async () => {
  await start();
  await click("Close");
  expect(replace).toHaveBeenCalledWith("/");
});
