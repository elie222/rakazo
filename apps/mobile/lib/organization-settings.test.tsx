// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OrganizationSettings from "../app/(settings)/organization";

const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "space-1",
  spaceIds: ["space-1"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};
const home = {
  id: "org-home",
  name: "Home",
  defaultSpaceId: "space-2",
  spaceIds: ["space-2"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};
const state = vi.hoisted(() => ({
  selectedSpace: "space-1",
  rpc: vi.fn(),
  refreshOrganizations: vi.fn(),
  leaveDeletedOrganization: vi.fn(),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => state.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = state.selectedSpace) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./organizations", () => ({
  useOrganizations: () => ({ data: { organizations: [work, home] } }),
  activeOrganization: () => work,
  refreshOrganizations: state.refreshOrganizations,
  leaveDeletedOrganization: state.leaveDeletedOrganization,
}));
vi.mock("./settings-sheet", () => ({ openFromSettingsSheet: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./roster-signals", () => ({ useLiveStream: () => {} }));
vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useRouter: () => ({}),
  useLocalSearchParams: () => ({ delete: "1" }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <progress />,
  StyleSheet: { create: (styles: unknown) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole === "alert" ? "alert" : undefined}>{children}</span>
  ),
}));
vi.mock("../components/load-failure", () => ({ LoadFailure: () => null }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
    onEndEditing,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    onEndEditing?: () => void;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={editable === false}
      onChange={(event) => onChangeText(event.target.value)}
      onBlur={onEndEditing}
    />
  ),
  SettingsRow: ({
    title,
    disabled,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockReset();
  state.refreshOrganizations.mockReset().mockResolvedValue(undefined);
  state.leaveDeletedOrganization.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<OrganizationSettings />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const nameInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
const button = (title: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === title)!;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const sent = (proc: string) => state.rpc.mock.calls.filter(([name]) => name === proc);

async function rename(next: string) {
  const input = nameInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

async function typeConfirmation() {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Type Work to confirm"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("holds the name while it saves, then reads the organizations again", async () => {
  const renaming = deferred<unknown>();
  state.rpc.mockReturnValueOnce(renaming.promise);
  await rename("Office");
  expect(sent("organizations/rename")).toEqual([
    [
      "organizations/rename",
      { organizationId: "org-work", name: "Office" },
      expect.objectContaining({ requestContext: expect.anything() }),
    ],
  ]);
  expect(nameInput().disabled).toBe(true);
  expect(button("Delete organization").disabled).toBe(true);
  await act(async () => renaming.resolve({}));
  await act(flush);
  expect(state.refreshOrganizations).toHaveBeenCalledOnce();
  expect(nameInput().disabled).toBe(false);
  // The draft gives way to the saved name the read brings back.
  expect(nameInput().value).toBe("Work");
});

it("shows why a rename failed and offers the name again", async () => {
  state.rpc.mockRejectedValueOnce(new Error("Name taken"));
  await rename("Office");
  await act(flush);
  expect(alertText()).toBe("Name taken");
  expect(nameInput().disabled).toBe(false);
  expect(nameInput().value).toBe("Office");
  expect(state.refreshOrganizations).not.toHaveBeenCalled();
});

it("deletes once when Delete is pressed twice, and stays held while the screen leaves", async () => {
  await typeConfirmation();
  state.rpc.mockResolvedValue({ activeSpaceId: "space-2" });
  await act(async () => {
    button("Delete").click();
    button("Delete").click();
  });
  await act(flush);
  expect(sent("organizations/remove")).toHaveLength(1);
  expect(state.leaveDeletedOrganization).toHaveBeenCalledExactlyOnceWith(work, "space-2");
  expect(button("Delete").disabled).toBe(true);
  expect(nameInput().disabled).toBe(true);
});

it("shows why a deletion failed and offers Delete again", async () => {
  await typeConfirmation();
  state.rpc.mockRejectedValueOnce(new Error("Still has members"));
  await act(async () => button("Delete").click());
  await act(flush);
  expect(alertText()).toBe("Still has members");
  expect(button("Delete").disabled).toBe(false);
  expect(state.leaveDeletedOrganization).not.toHaveBeenCalled();
});
