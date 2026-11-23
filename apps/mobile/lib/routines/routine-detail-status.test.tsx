// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RoutineDetail from "../../app/routine";

const state = vi.hoisted(() => ({
  useBotRoutines: vi.fn(),
  saveBotRoutine: vi.fn(),
  removeBotRoutine: vi.fn(),
  rpc: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
  blur: undefined as (() => void) | undefined,
  hardwareBack: undefined as (() => boolean) | undefined,
  params: { botId: "bot-1", routineId: "routine-1", origin: "profile" },
}));
const element =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(tag, null, children);

vi.mock("./routine-store", () => ({
  useBotRoutines: state.useBotRoutines,
  saveBotRoutine: state.saveBotRoutine,
  removeBotRoutine: state.removeBotRoutine,
  setRoutineActive: vi.fn(),
}));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./cron", () => ({ cronLabels: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./routine", () => ({
  deviceTimeZone: () => "UTC",
  routineTriggerRows: () => ["Every day at 9:00 AM"],
  routineWebTriggers: (routine: { webhookEnabled?: boolean }) =>
    routine.webhookEnabled ? [{ key: "webhookEnabled", label: "Webhook" }] : [],
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) =>
    createElement("div", null, children, footer),
  SettingsLabel: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  SettingsInputRow: () => null,
  SettingsRow: ({
    title,
    value,
    onPress,
    accessibilityState,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    accessibilityState?: { disabled?: boolean };
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-disabled": accessibilityState?.disabled },
      title,
      value,
    ),
  SettingsSwitch: () => null,
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPickerMenu: ({
    choices,
    disabled,
    onChange,
    children,
  }: {
    choices: Array<{ key: string; label: string }>;
    disabled?: boolean;
    onChange: (key: string) => void;
    children?: ReactNode;
  }) => [
    children,
    ...choices.map((choice) =>
      createElement(
        "button",
        { key: choice.key, type: "button", disabled, onClick: () => onChange(choice.key) },
        choice.label,
      ),
    ),
  ],
}));
vi.mock("../../components/thread/routine-event-row", () => ({ WebhookKeyButton: () => null }));
vi.mock("../../components/ui/growing-text-input", () => ({ GrowingTextInput: () => null }));
vi.mock("../../components/routines/routine-end-date", () => ({ RoutineEndDate: () => null }));
vi.mock("../../components/routines/routine-email-trigger", () => ({
  RoutineEmailTrigger: () => null,
}));
vi.mock("../../components/bots/bot-email", () => ({
  useBotEmail: () => ({ address: null, ownerDomain: "", setAddress: () => undefined }),
  useBotEmailRows: () => [],
}));
vi.mock("../../components/routines/routine-schedule-editor", () => ({
  RoutineScheduleEditor: () => null,
}));
vi.mock("../../components/native/glass-icon-button", () => ({ GlassIconButton: () => null }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("../../components/routines/routine-run-history", () => ({ RoutineRunHistory: () => null }));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) =>
      options?.headerRight?.() ?? null,
  },
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => {
      state.blur = effect();
      return state.blur;
    }, [effect]),
  useRouter: () => ({ push: vi.fn(), back: state.back }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: state.alert },
  BackHandler: {
    addEventListener: (_: string, handler: () => boolean) => {
      state.hardwareBack = handler;
      return { remove: vi.fn() };
    },
  },
  ScrollView: (props: { children?: ReactNode }) => element("div")(props),
  View: (props: { children?: ReactNode }) => element("div")(props),
  Text: (props: { children?: ReactNode }) => element("span")(props),
}));

let root: Root;
let container: HTMLDivElement;
const routine = {
  id: "routine-1",
  name: "Report",
  prompt: "Prepare the report.",
  crons: ["0 9 * * *"],
  active: true,
  nextRunAt: "2026-11-05T09:00:00.000Z",
  scheduleDelayed: true,
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.back.mockReset();
  state.alert.mockReset();
  state.removeBotRoutine.mockReset();
  state.saveBotRoutine.mockReset().mockImplementation(async () => routine);
  state.rpc.mockReset();
  state.params = { botId: "bot-1", routineId: "routine-1", origin: "profile" };
  state.useBotRoutines
    .mockReset()
    .mockReturnValue({ routines: [routine], failedSinceShown: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(RoutineDetail)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("refreshes recovered and newly delayed status while the detail stays open", async () => {
  expect(container.textContent).toContain("Schedule delayed");
  state.useBotRoutines.mockReturnValue({ routines: [{ ...routine, scheduleDelayed: false }] });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).not.toContain("Schedule delayed");
  state.useBotRoutines.mockReturnValue({ routines: [routine] });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).toContain("Schedule delayed");
});

it("shows another member's routine with its owner and a copy in place of the editor", async () => {
  state.useBotRoutines.mockReturnValue({
    routines: [{ ...routine, editable: false, runsAs: { name: "Dana", isViewer: false } }],
  });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).toContain("Prepare the report.");
  expect(container.textContent).toContain("OwnerDana");
  expect(container.textContent).toContain("Make a copy");
  expect(container.textContent).not.toContain("Edit routine");
});

it("names no owner on the viewer's own routine", async () => {
  state.useBotRoutines.mockReturnValue({
    routines: [{ ...routine, editable: true, runsAs: { name: "Riley", isViewer: true } }],
  });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).not.toContain("Owner");
  expect(container.textContent).toContain("Edit routine");
});

it("uses the shared routine store with focus-scoped polling enabled", () => {
  expect(state.useBotRoutines).toHaveBeenCalledWith("bot-1");
});

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label);
}

it("adds a webhook, makes the bot's key first, then saves the trigger", async () => {
  const key = deferred<{ secret: string }>();
  state.rpc.mockImplementation(async (proc: string) =>
    proc === "bots/get" ? { webhookConfigured: false } : key.promise,
  );
  await press("Edit routine");
  await press("Webhook");
  expect(state.rpc).toHaveBeenCalledWith(
    "bots/rotateWebhookSecret",
    { botId: "bot-1" },
    expect.anything(),
  );
  expect(container.textContent).toContain("Remove Webhook");
  expect(button("Save")?.disabled).toBe(true);
  await act(async () => key.resolve({ secret: "fake-key" }));
  expect(button("Save")?.disabled).toBe(false);
  await press("Save");
  expect(state.saveBotRoutine).toHaveBeenCalledWith("bot-1", {
    update: { routineId: "routine-1", webhookEnabled: true },
  });
});

it("never replaces a key the bot already has", async () => {
  state.rpc.mockResolvedValue({ webhookConfigured: true });
  await press("Edit routine");
  await press("Webhook");
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenCalledWith("bots/get", { botId: "bot-1" }, expect.anything());
});

it("takes the webhook back off when only the bot's creator can make its key", async () => {
  state.rpc.mockImplementation(async (proc: string) => {
    if (proc === "bots/get") return { webhookConfigured: false };
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
  });
  await press("Edit routine");
  await press("Webhook");
  expect(container.textContent).toContain("Only the bot's creator can set its webhook key.");
  expect(container.textContent).not.toContain("Remove Webhook");
});

it("holds the triggers until a new webhook's key request settles", async () => {
  const key = deferred();
  state.rpc.mockImplementation(async (proc: string) =>
    proc === "bots/get" ? { webhookConfigured: false } : key.promise,
  );
  await press("Edit routine");
  await press("Webhook");
  expect(button("Remove Webhook")?.disabled).toBe(true);
  expect(button("On a schedule")?.disabled).toBe(true);
  // The rows say so too, for screen readers.
  const held = () =>
    [...container.querySelectorAll('[aria-disabled="true"]')].map((row) => row.textContent);
  expect(held()).toEqual(["Webhook", "Add trigger"]);
  await act(async () => key.resolve(undefined));
  expect(held()).toEqual([]);
  expect(button("Remove Webhook")?.disabled).toBe(false);
  expect(button("On a schedule")?.disabled).toBe(false);
});

async function startDelete() {
  const held = deferred();
  state.removeBotRoutine.mockReturnValue(held.promise);
  await press("Edit routine");
  await press("Delete routine");
  await act(async () =>
    state.alert.mock.calls
      .at(-1)?.[2]
      .find((button: { text: string }) => button.text === "Delete")
      .onPress(),
  );
  return held.resolve;
}

it("goes back when deletion finishes in the original detail", async () => {
  const resolve = await startDelete();
  await act(async () => resolve());
  expect(state.back).toHaveBeenCalledTimes(1);
});

it("does not navigate after the detail loses focus", async () => {
  const resolve = await startDelete();
  act(() => state.blur?.());
  await act(async () => resolve());
  expect(state.back).not.toHaveBeenCalled();
});

it("does not navigate after leaving the detail", async () => {
  const resolve = await startDelete();
  await act(async () => root.render(null));
  await act(async () => resolve());
  expect(state.back).not.toHaveBeenCalled();
});

it("does not navigate a different routine after its params change", async () => {
  const resolve = await startDelete();
  state.params = { ...state.params, routineId: "routine-2" };
  await act(async () => root.render(createElement(RoutineDetail)));
  await act(async () => resolve());
  expect(state.back).not.toHaveBeenCalled();
});

it("does not pop the list after Cancel and Back while deletion is pending", async () => {
  const resolve = await startDelete();
  act(() => state.hardwareBack?.());
  expect(container.textContent).toContain("Edit routine");
  await act(async () => root.render(null));
  await act(async () => resolve());
  expect(state.back).not.toHaveBeenCalled();
});

it("still leaves the detail when the store removes the editor before completion", async () => {
  const resolve = await startDelete();
  state.useBotRoutines.mockReturnValue({ routines: [], readSinceShown: true });
  await act(async () => root.render(createElement(RoutineDetail)));
  await act(async () => resolve());
  expect(state.back).toHaveBeenCalledTimes(1);
});
