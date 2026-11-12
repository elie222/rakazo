// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceMembersScreen from "../app/space-members";

const { rpc, selectSpace, selectedSpaceId, alert, share, router } = vi.hoisted(() => ({
  rpc: vi.fn(),
  selectSpace: vi.fn(async () => true),
  selectedSpaceId: vi.fn(() => "space-shared"),
  alert: vi.fn(),
  share: vi.fn(async () => ({ action: "sharedAction" })),
  router: { back: vi.fn(), dismissAll: vi.fn(), replace: vi.fn() },
}));

vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc,
  selectedSpaceId,
}));
vi.mock("./api-server", () => ({
  selectSpace,
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("expo-router", () => ({
  useRouter: () => router,
  // Opened from Settings: no name in the link, so the sheet takes it from the list.
  useLocalSearchParams: () => ({ spaceId: "space-shared" }),
  Stack: { Screen: () => null },
}));
vi.mock("react-native", () => ({
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Alert: { alert },
  Share: { share },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Platform: { OS: "ios" },
  ActivityIndicator: () => createElement("div", { role: "progressbar" }),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
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
}));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

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
    "Invite",
  ]);
  expect(buttonNamed("Leave space")).toBeUndefined();

  await act(async () => buttonNamed("Invite")?.click());
  expect(rpc).toHaveBeenCalledWith("spaces/invites/create", { spaceId: "space-shared" });
  expect(share).toHaveBeenCalledWith({ url: "https://rakazo.example/invite/token-1" });
  // An open link can be cancelled until someone uses it.
  await act(async () => buttonNamed("Cancel open invites")?.click());
  expect(rpc).toHaveBeenCalledWith("spaces/invites/cancel", { spaceId: "space-shared" });
  expect(buttonNamed("Cancel open invites")).toBeUndefined();

  await act(async () => buttonNamed("Remove")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Remove Bob Stone?");
  expect(rpc).not.toHaveBeenCalledWith("spaces/members/remove", expect.anything());
  await act(async () => pressAlertButton("Remove"));
  expect(rpc).toHaveBeenCalledWith("spaces/members/remove", {
    spaceId: "space-shared",
    userId: "user-member",
  });
  expect(host.querySelectorAll("li")).toHaveLength(2);
});

it("lets a member leave and returns home in their own space", async () => {
  await render(false);
  expect(buttonNamed("Invite")).toBeUndefined();
  expect(buttonNamed("Remove")).toBeUndefined();

  await act(async () => buttonNamed("Leave space")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Leave Home?");
  await act(async () => pressAlertButton("Leave"));
  expect(rpc).toHaveBeenCalledWith("spaces/members/leave", { spaceId: "space-shared" });
  expect(selectSpace).toHaveBeenCalledWith("space-own");
  expect(router.dismissAll).toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("retries a failed first load without reopening the members screen", async () => {
  let finishRetry!: (value: unknown) => void;
  rpc.mockRejectedValueOnce(new Error("Offline")).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
  );
  await act(async () => root.render(createElement(SpaceMembersScreen)));
  expect(host.textContent).toContain("Offline");
  expect(buttonNamed("Retry")).toBeDefined();
  await act(async () => buttonNamed("Retry")?.click());
  expect(host.textContent).not.toContain("Offline");
  expect(buttonNamed("Retry")).toBeUndefined();
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith("spaces/members/list", { spaceId: "space-shared" });
  await act(async () =>
    finishRetry({ spaceName: "Home", members: [owner, member], canManage: true }),
  );
  expect(host.textContent).toContain("Ada Lovelace");
  expect(buttonNamed("Invite")).toBeDefined();
  expect(buttonNamed("Retry")).toBeUndefined();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
});

it("offers retry again if reloading the members fails", async () => {
  rpc.mockRejectedValueOnce(new Error("Offline")).mockRejectedValueOnce(new Error("Still offline"));
  await act(async () => root.render(createElement(SpaceMembersScreen)));
  expect(buttonNamed("Retry")).toBeDefined();
  await act(async () => buttonNamed("Retry")?.click());
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Still offline");
  expect(buttonNamed("Retry")).toBeDefined();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
});
