// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewOrganization from "../../app/new-organization";

const state = vi.hoisted(() => ({
  selectedSpace: "space-1",
  organizations: { organizations: [{ id: "org-1", name: "First", spaceIds: ["space-1"] }] },
  alert: vi.fn(),
  rpc: vi.fn(),
  switchOrganization: vi.fn(),
  refreshOrganizations: vi.fn(),
  replace: vi.fn(),
  dismissAll: vi.fn(),
}));

vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => state.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = state.selectedSpace) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./organizations", () => ({
  useOrganizations: () => ({ data: state.organizations }),
  switchOrganization: state.switchOrganization,
  refreshOrganizations: state.refreshOrganizations,
}));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: state.replace, dismissAll: state.dismissAll }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole === "alert" ? "alert" : undefined}>{children}</span>
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsInputRow: ({
    value,
    onChangeText,
    onSubmitEditing,
    editable,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    onSubmitEditing: () => void;
    editable?: boolean;
  }) => (
    <input
      value={value}
      disabled={editable === false}
      onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmitEditing();
      }}
    />
  ),
}));
vi.mock("../../components/native/native-action-button", () => ({
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

const created = { id: "org-2", name: "Second", defaultSpaceId: "space-2" };
const opened = {
  ...created,
  spaceIds: ["space-2"],
  canManage: true,
  role: "owner",
  memberCount: 1,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.selectedSpace = "space-1";
  state.rpc.mockReset();
  state.switchOrganization.mockReset();
  state.rpc.mockResolvedValue(created);
  // Opening the organization selects its Space, as the real switch does.
  state.switchOrganization.mockImplementation(async () => {
    state.selectedSpace = "space-2";
    return true;
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const submit = () => container.querySelector("button")!;
const field = () => container.querySelector("input")!;
const failure = () => container.querySelector('[role="alert"]')?.textContent ?? null;
async function start(name = "  Second  ") {
  await act(async () => root.render(<NewOrganization />));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), name);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("creates the organization for the account and opens it", async () => {
  await start();
  await act(async () => submit().click());
  expect(state.rpc).toHaveBeenCalledWith(
    "organizations/create",
    { name: "Second" },
    {
      requestContext: {
        apiBase: "http://api.test",
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": "space-1" },
      },
    },
  );
  expect(state.switchOrganization).toHaveBeenCalledWith(opened, state.organizations.organizations);
  expect(state.alert).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
});

it("does nothing without a name", async () => {
  await start("   ");
  expect(submit().disabled).toBe(true);
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(state.rpc).not.toHaveBeenCalled();
});

it("creates one organization when Create is tapped twice in one tick", async () => {
  await start();
  await act(async () => {
    submit().click();
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(state.rpc).toHaveBeenCalledOnce();
  expect(state.switchOrganization).toHaveBeenCalledOnce();
});

it("keeps Create held while the new organization opens and the sheet closes", async () => {
  const answer = deferred<typeof created>();
  state.rpc.mockReturnValueOnce(answer.promise);
  await start();
  await act(async () => submit().click());
  expect(submit().textContent).toBe("Creating…");
  expect(submit().disabled).toBe(true);
  expect(field().disabled).toBe(true);
  await act(async () => answer.resolve(created));
  // Its Space is selected by now; the sheet is still closing.
  expect(state.selectedSpace).toBe("space-2");
  await act(async () => root.render(<NewOrganization />));
  expect(submit().textContent).toBe("Creating…");
  expect(submit().disabled).toBe(true);
  expect(field().disabled).toBe(true);
  await act(async () => submit().click());
  expect(state.rpc).toHaveBeenCalledOnce();
});

it("returns home with an alert when the new organization cannot be opened", async () => {
  state.switchOrganization.mockResolvedValue(false);
  await start();
  await act(async () => submit().click());
  expect(state.refreshOrganizations).toHaveBeenCalledOnce();
  expect(state.alert).toHaveBeenCalledWith("Could not switch spaces", "Try again.");
  expect(state.dismissAll).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith("/");
  expect(submit().disabled).toBe(true);
  expect(failure()).toBeNull();
});

it("shows a failure inline and takes the next attempt", async () => {
  state.rpc.mockRejectedValueOnce(new Error("Name taken"));
  await start();
  await act(async () => submit().click());
  expect(failure()).toBe("Name taken");
  expect(submit().textContent).toBe("Create");
  expect(submit().disabled).toBe(false);
  expect(field().disabled).toBe(false);
  expect(state.switchOrganization).not.toHaveBeenCalled();
  const answer = deferred<typeof created>();
  state.rpc.mockReturnValueOnce(answer.promise);
  await act(async () => submit().click());
  expect(failure()).toBeNull();
  await act(async () => answer.resolve(created));
  expect(state.switchOrganization).toHaveBeenCalledOnce();
});

it("opens the new organization even when the sheet was closed before the answer", async () => {
  const answer = deferred<typeof created>();
  state.rpc.mockReturnValueOnce(answer.promise);
  await start();
  await act(async () => submit().click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => answer.resolve(created));
  expect(state.switchOrganization).toHaveBeenCalledWith(opened, state.organizations.organizations);
});
