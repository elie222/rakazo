// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceMembersScreen from "../../app/space-members";
import { queryClient } from "../query/query";

const { rpc, selectSpace, selectedSpaceId, alert, share, router } = vi.hoisted(() => ({
  rpc: vi.fn(),
  selectSpace: vi.fn(async () => true),
  selectedSpaceId: vi.fn(() => "space-shared"),
  alert: vi.fn(),
  share: vi.fn(async () => ({ action: "sharedAction" })),
  router: { back: vi.fn(), dismissAll: vi.fn(), replace: vi.fn() },
}));

vi.mock("../api/api", () => ({
  rpc,
  selectedSpaceId,
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async (spaceId: string | null = selectedSpaceId()) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../api/api-server", () => ({
  selectSpace,
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../settings/back-to-settings", () => ({ useBackToSettings: () => undefined }));
vi.mock("expo-router", () => ({
  useRouter: () => router,
  // Opened from Settings: no name in the link, so the sheet takes it from the list.
  useLocalSearchParams: () => ({ spaceId: "space-shared" }),
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
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
    actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
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
            disabled: action.attributes?.disabled,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) =>
    createElement("ul", null, children, footer ? createElement("p", null, footer) : null),
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  SettingsRow: ({
    title,
    detail,
    value,
    disabled,
    onPress,
  }: {
    title: string;
    detail?: string;
    value?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    createElement(
      "li",
      null,
      onPress
        ? createElement("button", { type: "button", disabled, onClick: onPress }, title)
        : [title, detail, value].filter(Boolean).join(" | "),
    ),
}));
vi.mock("../../components/native/sheet-header", () => ({
  cancelHeaderOptions: () => ({}),
}));
vi.mock("../native/native", () => ({
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

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
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

/** What the server holds, so a read after a change sees it. */
const server: { members: Array<typeof owner & { guest?: boolean }>; openInvites: number } = {
  members: [owner, member],
  openInvites: 0,
};
const pinned = {
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-shared" },
  },
};
const reads = () => rpc.mock.calls.filter(([procedure]) => procedure === "spaces/members/list");

async function render(canManage: boolean) {
  server.members = [owner, member];
  server.openInvites = 0;
  rpc.mockImplementation(async (procedure: string, input?: { userId?: string }) => {
    if (procedure === "spaces/members/list")
      return {
        spaceName: "Home",
        members: server.members,
        openInvites: server.openInvites,
        canManage,
      };
    if (procedure === "spaces/invites/create") {
      server.openInvites += 1;
      return { url: "https://rakazo.example/invite/token-1", expiresAt: "2026-10-29T00:00:00Z" };
    }
    if (procedure === "spaces/invites/cancel") server.openInvites = 0;
    if (procedure === "spaces/members/remove")
      server.members = server.members.filter((item) => item.userId !== input?.userId);
    if (procedure === "spaces/members/leave") return { ok: true, activeSpaceId: "space-own" };
    return { ok: true };
  });
  await act(async () => root.render(createElement(SpaceMembersScreen)));
  await act(flush);
}

it("lets the owner share an invite link and remove a member after confirming", async () => {
  await render(true);
  expect(rpc).toHaveBeenCalledWith(
    "spaces/members/list",
    { spaceId: "space-shared" },
    expect.objectContaining({ requestContext: pinned.requestContext }),
  );
  expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Ada Lovelace | ada@example.test | Owner",
    "Bob Stone | bob@example.test",
    "Invite",
  ]);
  expect(buttonNamed("Leave space")).toBeUndefined();

  await act(async () => buttonNamed("Share invite link")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith("spaces/invites/create", { spaceId: "space-shared" }, pinned);
  expect(share).toHaveBeenCalledWith({ url: "https://rakazo.example/invite/token-1" });
  // An open link can be cancelled until someone uses it.
  await act(async () => buttonNamed("Cancel open invites")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith("spaces/invites/cancel", { spaceId: "space-shared" }, pinned);
  expect(buttonNamed("Cancel open invites")).toBeUndefined();

  await act(async () => buttonNamed("Remove")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Remove Bob Stone?");
  expect(rpc).not.toHaveBeenCalledWith("spaces/members/remove", expect.anything());
  await act(async () => pressAlertButton("Remove"));
  await act(flush);
  expect(rpc).toHaveBeenCalledWith(
    "spaces/members/remove",
    { spaceId: "space-shared", userId: "user-member" },
    pinned,
  );
  expect(host.querySelectorAll("li")).toHaveLength(2);
});

it("lets a member leave and returns home in their own space", async () => {
  await render(false);
  expect(buttonNamed("Share invite link")).toBeUndefined();
  expect(buttonNamed("Remove")).toBeUndefined();

  await act(async () => buttonNamed("Leave space")?.click());
  expect(alert.mock.calls.at(-1)?.[0]).toBe("Leave Home?");
  await act(async () => pressAlertButton("Leave"));
  await act(flush);
  expect(rpc).toHaveBeenCalledWith("spaces/members/leave", { spaceId: "space-shared" }, pinned);
  expect(selectSpace).toHaveBeenCalledWith("space-own");
  expect(router.dismissAll).toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("retries a failed first load without reopening the members screen", async () => {
  let finishRetry!: Deferred<unknown>;
  rpc.mockRejectedValueOnce(new Error("Offline")).mockImplementationOnce(() => {
    finishRetry = deferred<unknown>();
    return finishRetry.promise;
  });
  await act(async () => root.render(createElement(SpaceMembersScreen)));
  expect(host.textContent).toContain("Offline");
  expect(buttonNamed("Retry")).toBeDefined();
  await act(async () => buttonNamed("Retry")?.click());
  expect(host.textContent).not.toContain("Offline");
  expect(buttonNamed("Retry")).toBeUndefined();
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith(
    "spaces/members/list",
    { spaceId: "space-shared" },
    expect.anything(),
  );
  await act(async () =>
    finishRetry.resolve({ spaceName: "Home", members: [owner, member], canManage: true }),
  );
  expect(host.textContent).toContain("Ada Lovelace");
  expect(buttonNamed("Share invite link")).toBeDefined();
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

it("holds Invite while open invites are being cancelled, so a new link is not cancelled with them", async () => {
  await render(true);
  await act(async () => buttonNamed("Share invite link")?.click());
  await act(flush);
  const cancelling = deferred<unknown>();
  rpc.mockImplementationOnce(() => cancelling.promise);
  await act(async () => buttonNamed("Cancel open invites")?.click());
  expect(buttonNamed("Share invite link")?.disabled).toBe(true);
  await act(async () => buttonNamed("Share invite link")?.click());
  expect(
    rpc.mock.calls.filter(([procedure]) => procedure === "spaces/invites/create"),
  ).toHaveLength(1);
  server.openInvites = 0;
  await act(async () => cancelling.resolve({ ok: true }));
  await act(flush);
  expect(buttonNamed("Share invite link")?.disabled).toBe(false);
  expect(buttonNamed("Cancel open invites")).toBeUndefined();
});

it("removes a member once when the confirmation is pressed twice, and reads the members again", async () => {
  await render(true);
  const before = reads().length;
  const removing = deferred<unknown>();
  rpc.mockImplementationOnce(() => removing.promise);
  await act(async () => buttonNamed("Remove")?.click());
  await act(async () => {
    pressAlertButton("Remove");
    pressAlertButton("Remove");
  });
  expect(
    rpc.mock.calls.filter(([procedure]) => procedure === "spaces/members/remove"),
  ).toHaveLength(1);
  expect(buttonNamed("Share invite link")?.disabled).toBe(true);
  server.members = [owner];
  await act(async () => removing.resolve({ ok: true }));
  await act(flush);
  expect(reads().length).toBe(before + 1);
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(buttonNamed("Share invite link")?.disabled).toBe(false);
});

it("keeps a member and releases the controls when removing fails", async () => {
  await render(true);
  rpc.mockImplementationOnce(async () => {
    throw new Error("Offline");
  });
  await act(async () => buttonNamed("Remove")?.click());
  await act(async () => pressAlertButton("Remove"));
  await act(flush);
  expect(alert).toHaveBeenLastCalledWith("Could not remove member", "Offline");
  expect(host.textContent).toContain("Bob Stone");
  expect(buttonNamed("Share invite link")?.disabled).toBe(false);
});

it("holds Leave until the space is left, and releases it when leaving fails", async () => {
  await render(false);
  const leaving = deferred<unknown>();
  rpc.mockImplementationOnce(() => leaving.promise);
  await act(async () => buttonNamed("Leave space")?.click());
  await act(async () => pressAlertButton("Leave"));
  expect(buttonNamed("Leave space")?.disabled).toBe(true);
  await act(async () => leaving.reject(new Error("Offline")));
  await act(flush);
  expect(alert).toHaveBeenLastCalledWith("Could not leave space", "Offline");
  expect(buttonNamed("Leave space")?.disabled).toBe(false);
  expect(router.replace).not.toHaveBeenCalled();
});

it("tags guests, and says before inviting someone by email that they are outside the organization", async () => {
  await render(true);
  const colleague = {
    userId: "user-colleague",
    name: "Cy Ray",
    email: "cy@example.test",
    image: null,
  };
  server.members = [owner, { ...member, guest: true }];
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "spaces/members/list")
      return {
        spaceName: "Home",
        members: server.members,
        openInvites: 0,
        canManage: true,
        addable: [colleague],
        organizationName: "Acme",
      };
    if (procedure === "spaces/invites/create")
      return { url: "https://rakazo.example/invite/token-2", expiresAt: "", emailed: true };
    return { ok: true };
  });
  await act(async () => queryClient.invalidateQueries());
  await act(flush);
  expect(host.textContent).toContain("Bob Stone | bob@example.test | External");

  await act(async () => buttonNamed("Invite by email")?.click());
  const notice = "Not in Acme. They'll only see this Space.";
  const type = async (text: string) => {
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("cy@example.test");
  expect(host.textContent).not.toContain(notice);
  await type("dee@example.test");
  expect(host.textContent).toContain(notice);
  await act(async () => buttonNamed("Invite")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith(
    "spaces/invites/create",
    { spaceId: "space-shared", email: "dee@example.test" },
    pinned,
  );
  // Emailed, so there is no link to share by hand.
  expect(share).not.toHaveBeenCalled();
  expect(host.querySelector('input[aria-label="Email"]')).toBeNull();

  await act(async () => buttonNamed("Invite by email")?.click());
  await type("cy@example.test");
  await act(async () => buttonNamed("Invite")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith(
    "spaces/members/add",
    { spaceId: "space-shared", userId: "user-colleague" },
    pinned,
  );
});
