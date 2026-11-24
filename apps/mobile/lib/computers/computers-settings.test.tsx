// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { CloudComputers } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AppPermissionsSettings from "../../app/(settings)/app-permissions";
import DevicesSettings from "../../app/(settings)/computers";
import { listUserDevices, removeUserDevice } from "../account/user-devices";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  cloud: vi.fn(),
  phones: vi.fn(),
  setSize: vi.fn(),
  push: vi.fn(),
  permissions: vi.fn(),
  requestPermission: vi.fn(),
  openSettings: vi.fn(),
  active: true,
}));

vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({ destructive: "#f00" }) }));
vi.mock("../native/native", () => ({
  native: { groupedPage: "#fff", secondaryLabel: "#888" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async (spaceId: string | null = "space-fixture") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: (method: string, body: unknown) => {
    if (method === "cloudComputers/list") return mocks.cloud();
    if (method === "cloudComputers/setSize") return mocks.setSize(body);
    if (method === "mobileDevices/list") return mocks.phones();
    throw new Error(`Unexpected ${method}`);
  },
}));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: vi.fn() }));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({
  useAppForeground: () => true,
  useAppActive: () => mocks.active,
}));
vi.mock("../personal-calendar/device-calendar", () => ({
  readAppleCalendarPermissions: mocks.permissions,
  requestAppleCalendarPermission: mocks.requestPermission,
}));
vi.mock("../account/user-devices", () => ({
  listUserDevices: vi.fn(),
  removeUserDevice: vi.fn(),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.push }),
  useIsFocused: () => true,
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => effect() ?? undefined, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
// The native menu as one button per choice.
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: Array<{ id: string; title: string; state?: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-pressed={action.state === "on"}
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {`Choose ${action.title}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) => (
    <section>
      {label ? <h3>{label}</h3> : null}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    value,
    detail,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    title: string;
    value?: string;
    detail?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => {
    const content = (
      <>
        {title}
        {value}
        {detail}
      </>
    );
    if (!onPress) {
      return <div data-label={accessibilityLabel ?? title}>{content}</div>;
    }
    return (
      <button
        type="button"
        aria-label={accessibilityLabel ?? title}
        disabled={disabled}
        onClick={onPress}
      >
        {content}
      </button>
    );
  },
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: ({
      children,
      refreshControl,
    }: {
      children?: ReactNode;
      refreshControl?: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {children}
      </div>
    ),
    RefreshControl: ({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) => (
      <button type="button" aria-label="Refresh" aria-busy={refreshing} onClick={onRefresh} />
    ),
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
      <span role="status" aria-label={accessibilityLabel} />
    ),
    Alert: { alert: vi.fn() },
    Linking: { openSettings: mocks.openSettings },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  mocks.cloud.mockResolvedValue(null);
  mocks.phones.mockResolvedValue([]);
  mocks.active = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function settle() {
  await act(flush);
  await act(flush);
}
async function render(screen: ReactNode = <DevicesSettings />) {
  await act(async () => root.render(screen));
  await settle();
}

function permissionGroup(label: string) {
  return [...container.querySelectorAll("h3")].find((heading) => heading.textContent === label)
    ?.parentElement;
}

it("shows only supported permissions and moves a granted permission to Authorized", async () => {
  const calendar = { kind: "calendar", granted: false };
  mocks.permissions.mockResolvedValue([calendar]);
  mocks.requestPermission.mockImplementation(async () => {
    mocks.permissions.mockResolvedValue([{ ...calendar, granted: true }]);
  });
  await render(<AppPermissionsSettings />);
  expect(permissionGroup("Available")?.querySelector("button")?.textContent).toBe(
    "CalendarConnect",
  );
  expect(permissionGroup("Authorized")?.textContent).toBe("AuthorizedNone");
  expect(permissionGroup("In development")).toBeUndefined();

  await act(async () => permissionGroup("Available")?.querySelector("button")?.click());
  await settle();
  expect(mocks.requestPermission).toHaveBeenCalledWith("calendar");
  expect(mocks.openSettings).not.toHaveBeenCalled();
  expect(permissionGroup("Authorized")?.querySelector("button")?.textContent).toBe(
    "CalendarSettings",
  );
});

it("opens system settings when another prompt is unavailable and refreshes on return", async () => {
  const calendar = { kind: "calendar", granted: false };
  mocks.permissions.mockResolvedValue([calendar]);
  mocks.requestPermission.mockResolvedValue("settings");
  await render(<AppPermissionsSettings />);

  await act(async () => permissionGroup("Available")?.querySelector("button")?.click());
  await settle();
  expect(mocks.requestPermission).toHaveBeenCalledWith("calendar");
  expect(mocks.openSettings).toHaveBeenCalledOnce();
  expect(permissionGroup("Available")?.querySelector("button")?.textContent).toBe(
    "CalendarConnect",
  );

  // iOS can pass through an inactive state even when still notionally in the foreground.
  mocks.active = false;
  await render(<AppPermissionsSettings />);
  mocks.permissions.mockResolvedValue([{ ...calendar, granted: true }]);
  mocks.active = true;
  await render(<AppPermissionsSettings />);
  expect(permissionGroup("Authorized")?.querySelector("button")?.textContent).toBe(
    "CalendarSettings",
  );

  await act(async () => permissionGroup("Authorized")?.querySelector("button")?.click());
  expect(mocks.openSettings).toHaveBeenCalledTimes(2);
  expect(mocks.requestPermission).toHaveBeenCalledOnce();
  mocks.active = false;
  await render(<AppPermissionsSettings />);
  mocks.permissions.mockResolvedValue([calendar]);
  mocks.active = true;
  await render(<AppPermissionsSettings />);

  expect(permissionGroup("Available")?.querySelector("button")?.textContent).toBe(
    "CalendarConnect",
  );
  expect(permissionGroup("Authorized")?.textContent).toBe("AuthorizedNone");
});

it("shows no permission controls when the device has no supported permissions", async () => {
  mocks.permissions.mockResolvedValue([]);
  await render(<AppPermissionsSettings />);

  expect(container.textContent).toContain("No app permissions to manage on this device");
  expect(container.textContent).not.toContain("In development");
  expect(container.querySelector("button")).toBeNull();
});

it("keeps a declined native prompt in Available", async () => {
  mocks.permissions.mockResolvedValue([{ kind: "calendar", granted: false }]);
  mocks.requestPermission.mockResolvedValue(undefined);
  await render(<AppPermissionsSettings />);

  await act(async () => permissionGroup("Available")?.querySelector("button")?.click());
  await settle();

  expect(mocks.requestPermission).toHaveBeenCalledWith("calendar");
  expect(mocks.openSettings).not.toHaveBeenCalled();
  expect(permissionGroup("Available")?.querySelector("button")?.textContent).toBe(
    "CalendarConnect",
  );
});
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
}
function lastAlertButtons() {
  return (vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as Array<{
    text?: string;
    style?: string;
    onPress?: () => void;
  }>;
}

const laptop = { deviceId: "d1", name: "Laptop", connected: true };
const desk = { deviceId: "d2", name: "Desk PC", connected: false };
const cloud: CloudComputers = {
  computers: [
    { id: "c1", scope: "team", botName: null, size: "standard", savedSize: "standard" },
    { id: "c2", scope: "dedicated", botName: "Researcher", size: "large", savedSize: "large" },
  ],
  available: ["standard", "large"],
  canManage: true,
};

it("lists paired computers and removes one after confirmation", async () => {
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop, desk]).mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await render();
  expect(container.textContent).toContain("LaptopOnline");
  expect(container.textContent).toContain("Desk PCOffline");

  await act(async () => button("Remove Desk PC, Offline")?.click());
  expect(Alert.alert).toHaveBeenCalledWith(
    "Remove Desk PC?",
    "This computer will stop running bots for your account",
    expect.arrayContaining([expect.objectContaining({ text: "Cancel", style: "cancel" })]),
  );
  expect(removeUserDevice).not.toHaveBeenCalled();
  await act(async () =>
    lastAlertButtons()
      .find((b) => b.style === "destructive")
      ?.onPress?.(),
  );
  await settle();
  expect(removeUserDevice).toHaveBeenCalledWith("d2");
  expect(container.textContent).not.toContain("Desk PC");
  expect(container.textContent).toContain("LaptopOnline");
});

it("lists signed-in phones alongside computers and opens permissions for this phone", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  mocks.phones.mockResolvedValue([
    {
      deviceId: "phone-1",
      platform: "android",
      name: null,
      connected: true,
      onlineUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      deviceId: "phone-2",
      platform: "ios",
      name: null,
      connected: true,
      onlineUntil: new Date(0).toISOString(),
    },
  ]);
  await render();

  expect(container.textContent).toContain("LaptopOnline");
  expect(container.querySelector('[data-label="Android phone, Online"]')?.tagName).toBe("DIV");
  expect(container.querySelector('[data-label="iPhone, Offline"]')?.tagName).toBe("DIV");
  await act(async () => button("App permissions")?.click());
  expect(mocks.push).toHaveBeenCalledWith("/app-permissions");
  expect(removeUserDevice).not.toHaveBeenCalled();
});

it("hides a computer while its removal is pending and shows it again when it fails", async () => {
  const finishRemove = deferred();
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice).mockReturnValue(finishRemove.promise);
  await render();
  await act(async () => button("Remove Laptop, Online")?.click());
  await act(async () =>
    lastAlertButtons()
      .find((b) => b.style === "destructive")
      ?.onPress?.(),
  );
  expect(container.textContent).not.toContain("Laptop");
  await act(async () => finishRemove.reject(new Error("offline")));
  await settle();
  expect(container.textContent).toContain("LaptopOnline");
  expect(container.textContent).toContain("offline");
});

it("keeps a removed computer gone when the list read after it fails", async () => {
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop, desk])
    .mockRejectedValue(new Error("offline"));
  vi.mocked(removeUserDevice).mockResolvedValue();
  await render();
  await act(async () => button("Remove Desk PC, Offline")?.click());
  await act(async () =>
    lastAlertButtons()
      .find((b) => b.style === "destructive")
      ?.onPress?.(),
  );
  await settle();
  expect(container.textContent).not.toContain("Desk PC");
  expect(container.textContent).toContain("LaptopOnline");
});

it("says when the cloud computers fail to load and retries them", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  mocks.cloud.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(cloud);
  await render();
  expect(container.textContent).toContain("offline");
  expect(container.textContent).not.toContain("No connected devices");
  await act(async () => button("Retry")?.click());
  await settle();
  expect(container.textContent).not.toContain("offline");
  expect(container.textContent).toContain("Cloud computers");
});

it("says when none are paired, and retries a failed load", async () => {
  vi.mocked(listUserDevices).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  await render();
  expect(container.textContent).toContain("offline");
  await act(async () => button("Retry")?.click());
  await settle();
  expect(container.textContent).toContain("No connected devices");
  expect(container.textContent).not.toContain("offline");
});

it("lists cloud computers above paired ones and changes a size", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  mocks.cloud.mockResolvedValueOnce(cloud).mockResolvedValue({
    ...cloud,
    computers: [
      cloud.computers[0],
      { ...cloud.computers[1], size: "standard", savedSize: "standard" },
    ],
  });
  mocks.setSize.mockResolvedValue(null);
  await render();
  const text = container.textContent ?? "";
  expect(text.indexOf("Cloud computers")).toBeLessThan(text.indexOf("Your devices"));
  expect(text).toContain("Team ComputerStandard");
  expect(text).toContain("ResearcherLarge (uses 2× hours)");

  // Team Computer is already Standard, so the unchecked Standard choice is the Researcher's.
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')]
      .find((candidate) => candidate.textContent === "Choose Standard")
      ?.click(),
  );
  await settle();
  expect(mocks.setSize).toHaveBeenCalledWith({ computerId: "c2", size: "standard" });
  expect(container.textContent).toContain("ResearcherStandardApplies on its next start.");
});

it("keeps a confirmed size selected when refreshing the cloud list fails", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  mocks.cloud.mockResolvedValueOnce(cloud).mockRejectedValue(new Error("offline"));
  mocks.setSize.mockResolvedValue({ ok: true });
  await render();

  const team = container.querySelector('[data-label="Team Computer"]')?.parentElement;
  const large = [...(team?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((option) =>
    option.textContent?.startsWith("Choose Large"),
  );
  expect(large?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => large?.click());
  await settle();

  expect(mocks.setSize).toHaveBeenCalledWith({ computerId: "c1", size: "large" });
  expect(mocks.cloud).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-label="Team Computer"]')?.textContent).toMatch(
    /Team ComputerLarge.*Applies on its next start/,
  );
  expect(large?.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("offline");

  await act(async () => large?.click());
  await settle();
  expect(mocks.setSize).toHaveBeenCalledOnce();
});

it("points a size above the plan to Billing without saving it", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  mocks.cloud.mockResolvedValue({ ...cloud, computers: [cloud.computers[0]] });
  await render();
  expect(container.textContent).not.toContain("No connected devices");
  await act(async () => button("Choose Extra large (uses 4× hours)")?.click());
  expect(mocks.setSize).not.toHaveBeenCalled();
  expect(vi.mocked(Alert.alert).mock.calls.at(-1)?.[0]).toBe(
    "Your plan does not include this size.",
  );
  await act(async () =>
    lastAlertButtons()
      .find((b) => b.text === "Upgrade")
      ?.onPress?.(),
  );
  expect(mocks.push).toHaveBeenCalledWith("/billing");
});

it("shows sizes without a menu to members who do not manage billing", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  mocks.cloud.mockResolvedValue({ ...cloud, canManage: false });
  await render();
  expect(container.textContent).toContain("ResearcherLarge (uses 2× hours)");
  expect(button("Choose Standard")).toBeUndefined();
});

it("alerts when a size change fails", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  mocks.cloud.mockResolvedValue({ ...cloud, computers: [cloud.computers[0]] });
  mocks.setSize.mockRejectedValue(new Error("nope"));
  await render();
  await act(async () => button("Choose Large (uses 2× hours)")?.click());
  await settle();
  expect(Alert.alert).toHaveBeenCalledWith("Could not change computer size");
  expect(container.querySelector('[data-label="Team Computer"]')?.textContent).toBe(
    "Team ComputerStandard",
  );
  expect(button("Choose Standard")?.getAttribute("aria-pressed")).toBe("true");
  expect(mocks.cloud).toHaveBeenCalledOnce();
});
