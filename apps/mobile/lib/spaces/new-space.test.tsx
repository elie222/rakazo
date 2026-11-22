// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewSpace from "../../app/new-space";

const state = vi.hoisted(() => ({
  focused: true,
  selectedSpace: "space-1",
  alert: vi.fn(),
  announce: vi.fn(),
  rpc: vi.fn(),
  selectSpace: vi.fn(),
  hapticSuccess: vi.fn(),
  refreshOrganizations: vi.fn(),
  replace: vi.fn(),
  dismissAll: vi.fn(),
  session: { generation: 4, apiBase: "http://api.test" },
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
vi.mock("../api/api-server", () => ({
  selectSpace: state.selectSpace,
}));
vi.mock("../native/haptics", () => ({ hapticSuccess: state.hapticSuccess }));
vi.mock("../search/search-inbox", () => ({
  searchInboxSession: () => ({ ...state.session }),
  isSearchInboxSession: (askedIn: typeof state.session) =>
    askedIn.generation === state.session.generation && askedIn.apiBase === state.session.apiBase,
}));
vi.mock("./organizations", () => ({ refreshOrganizations: state.refreshOrganizations }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../../components/native/sheet-header", () => ({ cancelHeaderOptions: () => ({}) }));
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
  AccessibilityInfo: { announceForAccessibility: state.announce },
  Alert: { alert: state.alert },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ accessibilityRole, children }: { accessibilityRole?: string; children?: ReactNode }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  TextInput: ({
    accessibilityLabel,
    placeholder,
    value,
    onChangeText,
    onSubmitEditing,
  }: {
    accessibilityLabel?: string;
    placeholder?: string;
    value: string;
    onChangeText: (value: string) => void;
    onSubmitEditing: () => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      placeholder={placeholder}
      value={value}
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

/** What a request sent from a Space carries. */
const sentFrom = (spaceId: string) => ({
  requestContext: {
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId },
  },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  state.focused = true;
  state.selectedSpace = "space-1";
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

it.each(["", "Work"])("keeps the Name label when the field contains %j", async (value) => {
  if (value) await type(value);
  const input = container.querySelector("input");

  expect(input?.getAttribute("aria-label")).toBe("Name");
  expect(input?.placeholder).toBe("Customer support");
  expect(input?.value).toBe(value);
  expect(container.querySelector("button")?.disabled).toBe(!value);
  expect(state.rpc).not.toHaveBeenCalled();
});

it("confirms space creation once after the server accepts the trimmed name", async () => {
  let finish!: Deferred<{ id: string; name: string }>;
  state.rpc.mockImplementation(() => {
    finish = deferred<{ id: string; name: string }>();
    return finish.promise;
  });
  await type("  Work  ");
  await act(async () => container.querySelector("button")!.click());
  expect(state.rpc).toHaveBeenCalledWith("spaces/create", { name: "Work" }, sentFrom("space-1"));
  expect(state.hapticSuccess).not.toHaveBeenCalled();
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => finish.resolve({ id: "space-new", name: "Work" }));
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

it("announces a failed space creation as an alert, again when a retry fails", async () => {
  state.rpc.mockRejectedValue(new Error("Creation failed"));
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Creation failed");
  expect(state.announce).toHaveBeenCalledOnce();
  expect(state.announce).toHaveBeenLastCalledWith("Creation failed");
  await act(async () => container.querySelector("button")!.click());
  expect(state.announce).toHaveBeenCalledTimes(2);
  expect(state.announce).toHaveBeenLastCalledWith("Creation failed");
});

it("speaks the server's refusal as the same text the screen shows", async () => {
  state.rpc.mockRejectedValue(new Error("That name is already used"));
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("That name is already used");
  expect(state.announce).toHaveBeenCalledWith("That name is already used");
});

it("does not announce anything when a retry succeeds", async () => {
  state.rpc.mockRejectedValueOnce(new Error("Creation failed"));
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.announce).toHaveBeenCalledOnce();
  await act(async () => container.querySelector("button")!.click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-new");
  expect(state.announce).toHaveBeenCalledOnce();
});

it("announces a failure only once the creation has failed, not while it is pending", async () => {
  let fail!: Deferred<{ id: string; name: string }>;
  state.rpc.mockImplementation(() => {
    fail = deferred<{ id: string; name: string }>();
    return fail.promise;
  });
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.announce).not.toHaveBeenCalled();
  await act(async () => fail.reject(new Error("Creation failed")));
  expect(state.announce).toHaveBeenCalledOnce();
  expect(state.announce).toHaveBeenLastCalledWith("Creation failed");
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
  let finish!: Deferred<{ id: string; name: string }>;
  state.rpc.mockImplementation(() => {
    finish = deferred<{ id: string; name: string }>();
    return finish.promise;
  });
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.rpc).toHaveBeenCalledWith("spaces/create", { name: "Work" }, sentFrom("space-1"));
  state.focused = false;
  await act(async () => finish.resolve({ id: "space-new", name: "Work" }));
  expect(state.hapticSuccess).not.toHaveBeenCalled();
  // The space exists by then, so it is still opened.
  expect(state.selectSpace).toHaveBeenCalledWith("space-new");
  expect(state.replace).toHaveBeenCalledWith("/");
});

it("creates one space when Create is tapped twice in one tick", async () => {
  await type("Work");
  await act(async () => {
    container.querySelector("button")!.click();
    container.querySelector("button")!.click();
  });
  expect(state.rpc).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledOnce();
});

it("keeps Create held once the space is made, while the sheet closes", async () => {
  // Opening the new space selects it, which must not hand the button back.
  state.selectSpace.mockImplementation(async (id: string) => {
    state.selectedSpace = id;
    return true;
  });
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.dismissAll).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith("/");
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => container.querySelector("button")!.click());
  expect(state.rpc).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledOnce();
});

it("says so when the new space could not be opened, and still returns home", async () => {
  state.selectSpace.mockResolvedValue(false);
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "Space created",
    "It could not be opened. Try again from the sidebar.",
  );
  expect(state.dismissAll).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith("/");
});

it("shows a space that failed while opening as not created, and permits retry", async () => {
  state.selectSpace.mockRejectedValue(new Error("Storage unavailable"));
  await type("Work");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Storage unavailable");
  expect(state.replace).not.toHaveBeenCalled();
  expect(container.querySelector("button")?.disabled).toBe(false);
});
