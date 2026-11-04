// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Server from "../app/server";
import type * as Endpoint from "./endpoint";
import type * as ThreadFeedback from "./thread-feedback";
import { hasUnsentSends } from "./thread-feedback";

const server = vi.hoisted(() => ({
  base: "https://one.example.test",
  custom: false,
  options: {} as Record<string, unknown>,
}));
const api = vi.hoisted(() => ({
  probe: vi.fn(),
  reset: vi.fn(),
  save: vi.fn(),
}));

vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options: Record<string, unknown> }) => {
      server.options = options;
      return null;
    },
  },
  useRouter: () => ({ back: vi.fn(), canGoBack: () => false, replace: vi.fn() }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: { alert: vi.fn() },
    KeyboardAvoidingView: View,
    Platform: { OS: "ios" },
    ScrollView: View,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: View,
    TextInput: ({
      onChangeText,
      placeholder,
      value,
    }: {
      onChangeText?: (value: string) => void;
      placeholder?: string;
      value?: string;
    }) => (
      <input
        onChange={(event) => onChangeText?.(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    ),
    View,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/header-rows-editor", () => ({ HeaderRowsEditor: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress?: () => void }) => (
    <button onClick={onPress} type="button">
      {label}
    </button>
  ),
}));
// Plain markers, so the header actions can be called straight from the captured options.
vi.mock("../components/sheet-header", () => ({
  cancelHeaderOptions: (label: string, onPress: () => void) => ({ headerLeft: { label, onPress } }),
  trailingHeaderOptions: (label: string, onPress: () => void, disabled?: boolean) => ({
    headerRight: { label, onPress, disabled },
  }),
}));
vi.mock("./api", async () => {
  const endpoint = await vi.importActual<typeof Endpoint>("./endpoint");
  return {
    apiBaseWarning: () => null,
    currentApiBase: () => server.base,
    defaultApiBase: endpoint.defaultApiBase,
    normalizeApiBase: endpoint.normalizeApiBase,
    probeApiBase: api.probe,
    resetApiBase: api.reset,
    saveApiBase: api.save,
    usesCustomApiBase: () => server.custom,
  };
});
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ locale: "en", t: (text: string) => text }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./unsent-sends", () => ({ unsentSendsRestored: vi.fn(async () => true) }));
vi.mock("./thread-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof ThreadFeedback>()),
  hasUnsentSends: vi.fn(() => false),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  server.custom = false;
  api.probe.mockImplementation(async (draft: string) => ({ ok: true, url: draft }));
  api.save.mockResolvedValue({ ok: true, url: "" });
  api.reset.mockResolvedValue({ ok: true, url: "" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

async function renderServer(draft?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Server />));
  if (draft) {
    const input = container.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, draft);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

async function pressSave() {
  const { headerRight } = server.options as { headerRight: { onPress: () => void } };
  await act(async () => headerRight.onPress());
}

async function pressButton(label: string) {
  const target = Array.from(container!.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  await act(async () => target!.click());
}

function alertButtons(index = 0) {
  return vi.mocked(Alert.alert).mock.calls[index]![2]!;
}

it("asks before switching servers deletes unsent messages", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  try {
    await renderServer("https://two.example.test");
    await pressSave();
    // Asked only once the new server answered, and before anything is saved.
    expect(api.probe).toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(alertButtons()[1]!.text).toBe("Switch anyway");
    await act(async () => alertButtons()[1]!.onPress?.());
    expect(api.save).toHaveBeenCalled();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("keeps unsent messages when the server switch is cancelled", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  try {
    await renderServer("https://two.example.test");
    await pressSave();
    await act(async () => alertButtons()[0]!.onPress?.());
    expect(api.save).not.toHaveBeenCalled();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("shows why a switch cannot happen without asking about unsent messages", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  api.probe.mockResolvedValueOnce({ ok: false, error: "Could not reach this server" });
  try {
    await renderServer("https://two.example.test");
    await pressSave();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Could not reach this server");
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("saves the same server without asking about unsent messages", async () => {
  await renderServer();
  await pressSave();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(api.save).toHaveBeenCalled();
});

it("asks before returning to the default server deletes unsent messages", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  server.custom = true;
  try {
    await renderServer();
    await pressButton("Use default server");
    expect(api.reset).not.toHaveBeenCalled();
    expect(alertButtons()[1]!.text).toBe("Switch anyway");
    await act(async () => alertButtons()[1]!.onPress?.());
    expect(api.reset).toHaveBeenCalled();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("holds the save lock while the unsent-message confirmation is open", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  try {
    await renderServer("https://two.example.test");
    // A second submit (keyboard Go while the alert is open) must not start a parallel switch.
    await pressSave();
    await pressSave();
    expect(Alert.alert).toHaveBeenCalledOnce();

    await act(async () => alertButtons()[0]!.onPress?.());
    expect(api.save).not.toHaveBeenCalled();
    // Cancelling released the lock, so a later save asks again.
    await pressSave();
    expect(Alert.alert).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});
