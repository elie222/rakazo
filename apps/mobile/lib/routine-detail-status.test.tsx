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

vi.mock("./routine-store", () => ({ useBotRoutines: state.useBotRoutines }));
vi.mock("./i18n", () => {
  const t = (message: string) => message;
  return { useI18n: () => ({ t }) };
});
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./routine", () => ({
  routineStatusLine: (routine: { scheduleDelayed?: boolean }) =>
    routine.scheduleDelayed ? "Schedule delayed" : "Active",
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../components/routine-run-history", () => ({ RoutineRunHistory: () => null }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ botId: "bot-1", routineId: "routine-1", origin: "profile" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
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

it("does not keep claiming a delay after a failed status read, and recovers on the next poll", async () => {
  state.useBotRoutines.mockReturnValue({ routines: [routine], failedSinceShown: true });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).not.toContain("Schedule delayed");
  state.useBotRoutines.mockReturnValue({ routines: [routine], failedSinceShown: false });
  await act(async () => root.render(createElement(RoutineDetail)));
  expect(container.textContent).toContain("Schedule delayed");
  expect(container.textContent).not.toContain("Could not load routine");
});

it("uses the shared routine store with focus-scoped polling enabled", () => {
  expect(state.useBotRoutines).toHaveBeenCalledWith("bot-1");
});
