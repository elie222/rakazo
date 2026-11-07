// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RoutineDetail from "../app/routine";

const state = vi.hoisted(() => ({ useBotRoutines: vi.fn() }));
const element =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(tag, null, children);

vi.mock("./routine-store", () => ({
  useBotRoutines: state.useBotRoutines,
  saveBotRoutine: vi.fn(),
  removeBotRoutine: vi.fn(),
  setRoutineActive: vi.fn(),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => {
  const t = (message: string) => message;
  return { useI18n: () => ({ t, locale: "en" }), dateLocaleForUi: () => "en-US" };
});
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./cron", () => ({ cronLabels: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./routine", () => ({
  deviceTimeZone: () => "UTC",
  routineTriggerRows: () => ["Every day at 9:00 AM"],
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) =>
    createElement("div", null, children, footer),
  SettingsLabel: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  SettingsInputRow: () => null,
  SettingsRow: ({ title, value }: { title: string; value?: string }) =>
    createElement("span", null, title, value),
  SettingsSwitch: () => null,
}));
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
  useLocalSearchParams: () => ({ botId: "bot-1", routineId: "routine-1", origin: "profile" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
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
