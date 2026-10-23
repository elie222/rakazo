// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceMembersScreen from "../app/space-members";

const { rpc, selectSpace, selectedSpaceId, alert, share, router, header } = vi.hoisted(() => ({
  rpc: vi.fn(),
  selectSpace: vi.fn(async () => true),
  selectedSpaceId: vi.fn(() => "space-shared"),
  alert: vi.fn(),
  share: vi.fn(async () => ({ action: "sharedAction" })),
  router: { back: vi.fn(), dismissAll: vi.fn(), replace: vi.fn() },
  header: { invite: undefined as (() => void) | undefined },
}));

vi.mock("./api", () => ({ rpc, selectSpace, selectedSpaceId }));
vi.mock("expo-router", () => ({
  useRouter: () => router,
  // Opened from Settings: no name in the link, so the sheet takes it from the list.
  useLocalSearchParams: () => ({ spaceId: "space-shared" }),
  Stack: {
    Screen: ({ options }: { options: { invite?: () => void } }) => {
      header.invite = options.invite;
      return null;
    },
  },
}));
vi.mock("react-native", () => ({
  Alert: { alert },
  Share: { share },
  Platform: { OS: "ios" },
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    createElement(
      "div",
      null,
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("ul", null, children),
  SettingsRow: ({
    title,
    detail,
    value,
    onPress,
  }: {
    title: string;
    detail?: string;
    value?: string;
    onPress?: () => void;
  }) =>
    createElement(
      "li",
      null,
      onPress
        ? createElement("button", { type: "button", onClick: onPress }, title)
        : [title, detail, value].filter(Boolean).join(" | "),
    ),
}));
vi.mock("../components/sheet-header", () => ({
  cancelHeaderOptions: () => ({}),
  trailingHeaderOptions: (_label: string, onPress: () => void) => ({ invite: onPress }),
}));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? "");
  return { t, useI18n: () => ({ t }) };
});

const owner = {
  userId: "user-owner",
  name: "Ada Lovelace",
  email: "ada@example.test",
  image: null,
  role: "owner",
};
const member = {
  userId: "user-member",
  name: "Bob Stone",
  email: "bob@example.test",
  image: null,
  role: "member",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  header.invite = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function buttonNamed(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}

function pressAlertButton(text: string) {
  const buttons = alert.mock.calls.at(-1)?.[2] as { text: string; onPress?: () => void }[];
  buttons.find((button) => button.text === text)?.onPress?.();
}

async function render(canManage: boolean) {
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "spaces/members/list")
      return { spaceName: "Home", members: [owner, member], canManage };
    if (procedure === "spaces/invites/create")
      return { url: "https://rakazo.example/invite/token-1", expiresAt: "2026-10-29T00:00:00Z" };
    if (procedure === "spaces/members/leave") return { ok: true, activeSpaceId: "space-own" };
    return { ok: true };
  });
  await act(async () => root.render(createElement(SpaceMembersScreen)));
}

it("lets the owner share an invite link and remove a member after confirming", async () => {
  await render(true);
  expect(rpc).toHaveBeenCalledWith("spaces/members/list", { spaceId: "space-shared" });
  expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Ada Lovelace | ada@example.test | Owner",
    "Bob Stone | bob@example.test",
  ]);
  expect(buttonNamed("Leave space")).toBeUndefined();

  await act(async () => header.invite?.());
  expect(rpc).toHaveBeenCalledWith("spaces/invites/create", { spaceId: "space-shared" });
  expect(share).toHaveBeenCalledWith({ url: "https://rakazo.example/invite/token-1" });

  await act(async () => buttonNamed("Remove")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Remove Bob Stone?");
  expect(rpc).not.toHaveBeenCalledWith("spaces/members/remove", expect.anything());
  await act(async () => pressAlertButton("Remove"));
  expect(rpc).toHaveBeenCalledWith("spaces/members/remove", {
    spaceId: "space-shared",
    userId: "user-member",
  });
  expect(host.querySelectorAll("li")).toHaveLength(1);
});

it("lets a member leave and returns home in their own space", async () => {
  await render(false);
  expect(header.invite).toBeUndefined();
  expect(buttonNamed("Remove")).toBeUndefined();

  await act(async () => buttonNamed("Leave space")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Leave Home?");
  await act(async () => pressAlertButton("Leave"));
  expect(rpc).toHaveBeenCalledWith("spaces/members/leave", { spaceId: "space-shared" });
  expect(selectSpace).toHaveBeenCalledWith("space-own");
  expect(router.dismissAll).toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith("/");
});
