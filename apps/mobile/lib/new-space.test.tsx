// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewSpace from "../app/new-space";

const state = vi.hoisted(() => ({
  focused: true,
  rpc: vi.fn(),
  selectSpace: vi.fn(),
  hapticSuccess: vi.fn(),
  refreshOrganizations: vi.fn(),
  replace: vi.fn(),
  dismissAll: vi.fn(),
  session: { generation: 4, apiBase: "http://api.test" },
}));

vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
}));
vi.mock("./api-server", () => ({
  selectSpace: state.selectSpace,
}));
vi.mock("./haptics", () => ({ hapticSuccess: state.hapticSuccess }));
vi.mock("./search-inbox", () => ({
  searchInboxSession: () => ({ ...state.session }),
  isSearchInboxSession: (askedIn: typeof state.session) =>
    askedIn.generation === state.session.generation && askedIn.apiBase === state.session.apiBase,
}));
vi.mock("./organizations", () => ({ refreshOrganizations: state.refreshOrganizations }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../components/sheet-header", () => ({ cancelHeaderOptions: () => ({}) }));
vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => state.focused }),
  Stack: { Screen: () => null },
  useRouter: () => ({
    replace: state.replace,
    dismissAll: state.dismissAll,
    back: vi.fn(),
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    onSubmitEditing,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    onSubmitEditing: () => void;
  }) => (
    <input
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmitEditing();
      }}
    />
  ),
}));
vi.mock("../components/native-action-button", () => ({
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

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  state.focused = true;
  Object.assign(state.session, { generation: 4, apiBase: "http://api.test" });
  state.rpc.mockResolvedValue({ id: "space-new", name: "Work" });
  state.selectSpace.mockResolvedValue(true);
  state.refreshOrganizations.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<NewSpace />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function type(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("confirms space creation once after the server accepts the trimmed name", async () => {
  let finish!: (space: { id: string; name: string }) => void;
  state.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await type("  Work  ");
  await act(async () => container.querySelector("button")!.click());
  expect(state.rpc).toHaveBeenCalledWith("spaces/create", { name: "Work" });
  expect(state.hapticSuccess).not.toHaveBeenCalled();
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => finish({ id: "space-new", name: "Work" }));
  expect(state.hapticSuccess).toHaveBeenCalledOnce();
  expect(state.selectSpace).toHaveBeenCalledWith("space-new");
});

it("does not confirm a failed space creation and permits retry", async () => {
  state.rpc.mockRejectedValue(new Error("Creation failed"));
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.hapticSuccess).not.toHaveBeenCalled();
  expect(state.selectSpace).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Creation failed");
  expect(container.querySelector("button")?.disabled).toBe(false);
});

it("does not confirm or submit an empty name", async () => {
  await type("   ");
  await act(async () => {
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.hapticSuccess).not.toHaveBeenCalled();
});

it("does not confirm a space created after the session changes", async () => {
  state.rpc.mockImplementation(async () => {
    state.session.generation += 1;
    return { id: "space-new", name: "Work" };
  });
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.hapticSuccess).not.toHaveBeenCalled();
});

it("does not confirm space creation after its screen loses focus", async () => {
  let finish!: (space: { id: string; name: string }) => void;
  state.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.rpc).toHaveBeenCalledWith("spaces/create", { name: "Work" });
  state.focused = false;
  await act(async () => finish({ id: "space-new", name: "Work" }));
  expect(state.hapticSuccess).not.toHaveBeenCalled();
});
