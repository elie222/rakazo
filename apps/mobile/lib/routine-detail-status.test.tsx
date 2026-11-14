// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RoutineDetail from "../app/routine";

const state = vi.hoisted(() => ({
  useBotRoutines: vi.fn(),
  removeBotRoutine: vi.fn(),
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
  saveBotRoutine: vi.fn(),
  removeBotRoutine: state.removeBotRoutine,
  setRoutineActive: vi.fn(),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./cron", () => ({ cronLabels: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./routine", () => ({
  deviceTimeZone: () => "UTC",
  routineTriggerRows: () => ["Every day at 9:00 AM"],
  routineWebTriggers: () => [],
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) =>
    createElement("div", null, children, footer),
  SettingsLabel: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  SettingsInputRow: () => null,
  SettingsRow: ({
    title,
    value,
    onPress,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
  }) => createElement("button", { type: "button", onClick: onPress }, title, value),
  SettingsSwitch: () => null,
}));
vi.mock("../components/menu-picker", () => ({ MenuPickerMenu: () => null }));
vi.mock("../components/growing-text-input", () => ({ GrowingTextInput: () => null }));
vi.mock("../components/routine-email-trigger", () => ({ RoutineEmailTrigger: () => null }));
vi.mock("../components/bot-email", () => ({
  useBotEmail: () => ({ address: null, ownerDomain: "", setAddress: () => undefined }),
  useBotEmailRows: () => [],
}));
vi.mock("../components/routine-schedule-editor", () => ({ RoutineScheduleEditor: () => null }));
vi.mock("../components/glass-icon-button", () => ({ GlassIconButton: () => null }));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../components/routine-run-history", () => ({ RoutineRunHistory: () => null }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
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

it("shows a routine another member created without the editor", async () => {
  state.useBotRoutines.mockReturnValue({ routines: [{ ...routine, editable: false }] });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).toContain("Prepare the report.");
  expect(container.textContent).not.toContain("Edit routine");
});

it("uses the shared routine store with focus-scoped polling enabled", () => {
  expect(state.useBotRoutines).toHaveBeenCalledWith("bot-1");
});

async function startDelete() {
  let resolve!: () => void;
  state.removeBotRoutine.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const press = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await press("Edit routine");
  await press("Delete routine");
  await act(async () =>
    state.alert.mock.calls
      .at(-1)?.[2]
      .find((button: { text: string }) => button.text === "Delete")
      .onPress(),
  );
  return resolve;
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
