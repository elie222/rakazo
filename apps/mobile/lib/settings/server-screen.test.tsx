// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Server from "../../app/server";
import type * as Endpoint from "../api/endpoint";
import type * as ThreadFeedback from "../thread/send/thread-feedback";
import { hasUnsentSends } from "../thread/send/thread-feedback";

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
const announce = vi.hoisted(() => vi.fn());
const saved = vi.hoisted(() => ({
  list: [] as Array<{ apiBase: string; headers: Record<string, string> }>,
  remove: vi.fn(),
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
      editable,
      onChangeText,
      placeholder,
      value,
    }: {
      editable?: boolean;
      onChangeText?: (value: string) => void;
      placeholder?: string;
      value?: string;
    }) => (
      <input
        onChange={(event) => onChangeText?.(event.target.value)}
        placeholder={placeholder}
        readOnly={editable === false}
        value={value}
      />
    ),
    View,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/integrations/header-rows-editor", () => ({
  HeaderRowsEditor: () => null,
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress} type="button">
      {title}
    </button>
  ),
}));
// Shows the row's menu action as its own button, so a test can pick it.
vi.mock("../../components/ui/long-press-menu", () => ({
  LongPressMenu: ({
    children,
    onPressAction,
    title,
  }: {
    children: (onLongPress: undefined) => ReactNode;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
  }) => (
    <div>
      {children(undefined)}
      <button
        onClick={() => onPressAction({ nativeEvent: { event: "remove" } })}
        type="button"
      >{`Remove ${title}`}</button>
    </div>
  ),
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress?: () => void }) => (
    <button onClick={onPress} type="button">
      {label}
    </button>
  ),
}));
// Plain markers, so the header actions can be called straight from the captured options.
vi.mock("../../components/native/sheet-header", () => ({
  cancelHeaderOptions: (label: string, onPress: () => void) => ({ headerLeft: { label, onPress } }),
  trailingHeaderOptions: (label: string, onPress: () => void, disabled?: boolean) => ({
    headerRight: { label, onPress, disabled },
  }),
}));
vi.mock("../api/api", () => ({ currentApiBase: () => server.base }));
vi.mock("../api/api-server", () => ({ resetApiBase: api.reset, saveApiBase: api.save }));
vi.mock("../api/endpoint", async () => {
  const endpoint = await vi.importActual<typeof Endpoint>("../api/endpoint");
  return {
    ...endpoint,
    apiBaseWarning: () => null,
    probeApiBase: api.probe,
    usesCustomApiBase: () => server.custom,
  };
});
vi.mock("../native/announce", () => ({ announceToScreenReader: announce }));
vi.mock("../native/native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("../api/saved-servers", () => ({
  removeSavedServer: saved.remove,
  savedServers: () => saved.list,
}));
vi.mock("../api/server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../thread/send/unsent-sends", () => ({ unsentSendsRestored: vi.fn(async () => true) }));
vi.mock("../thread/send/thread-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof ThreadFeedback>()),
  hasUnsentSends: vi.fn(() => false),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  server.custom = false;
  saved.list = [];
  saved.remove.mockResolvedValue(true);
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
  if (draft) await editAddress(draft);
}

async function editAddress(value: string) {
  const input = container!.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

it("keeps the address read-only during a pending probe and accepts edits after it fails", async () => {
  const checked = deferred<{ ok: false; error: string }>();
  api.probe.mockReturnValueOnce(checked.promise);
  await renderServer("https://two.example.test");
  const address = container!.querySelector("input")!;

  expect(address.readOnly).toBe(false);
  await pressSave();
  expect(address.readOnly).toBe(true);
  expect(address.value).toBe("https://two.example.test");

  await act(async () => checked.resolve({ ok: false, error: "Could not reach this server" }));
  expect(api.save).not.toHaveBeenCalled();
  expect(container?.textContent).toContain("Could not reach this server");
  expect(address.readOnly).toBe(false);

  await editAddress("https://three.example.test");
  expect(address.value).toBe("https://three.example.test");
  await pressSave();
  expect(api.probe.mock.lastCall?.[0]).toBe("https://three.example.test");
});

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
    const address = container!.querySelector("input")!;
    expect(address.readOnly).toBe(true);

    await act(async () => alertButtons()[0]!.onPress?.());
    expect(api.save).not.toHaveBeenCalled();
    expect(address.readOnly).toBe(false);
    // Cancelling released the lock, so a later save asks again.
    await pressSave();
    expect(Alert.alert).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

const ACCESS = { "CF-Access-Client-Id": "id.access" };

it("lists no saved servers until the device has used one", async () => {
  await renderServer();
  expect(container?.textContent).not.toContain("two.example.test");
});

it("switches to a saved server with the headers it was saved with, not the screen's rows", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: ACCESS }];
  await renderServer();
  await pressButton("two.example.test");
  expect(api.probe).toHaveBeenCalledWith("https://two.example.test", fetch, ACCESS);
  expect(api.save).toHaveBeenCalledWith("https://two.example.test", ACCESS);
});

it("does not list the server in use", async () => {
  saved.list = [
    { apiBase: "https://one.example.test", headers: {} },
    { apiBase: "https://two.example.test", headers: {} },
  ];
  await renderServer();
  expect(container?.textContent).toContain("two.example.test");
  expect(container?.textContent).not.toContain("one.example.test");
});

it("stays on the current server when a saved server does not answer", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  api.probe.mockResolvedValueOnce({ ok: false, error: "Could not reach that server" });
  await renderServer();
  await pressButton("two.example.test");
  expect(api.save).not.toHaveBeenCalled();
  expect(container?.textContent).toContain("Could not reach that server");
});

it("asks about unsent messages before switching to a saved server", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  try {
    await renderServer();
    await pressButton("two.example.test");
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => alertButtons()[0]!.onPress?.());
    expect(api.save).not.toHaveBeenCalled();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("removes a saved server from the list", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  saved.remove.mockImplementation(async () => {
    saved.list = [];
    return true;
  });
  await renderServer();
  await pressButton("Remove two.example.test");
  expect(saved.remove).toHaveBeenCalledWith("https://two.example.test");
  expect(container?.textContent).not.toContain("two.example.test");
});

it("keeps a saved server listed and says so when it cannot be removed", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  saved.remove.mockResolvedValue(false);
  await renderServer();
  await pressButton("Remove two.example.test");
  expect(container?.textContent).toContain("Could not remove the server");
  expect(container?.textContent).toContain("two.example.test");
});

it("clears the failure message once a retried removal works", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  saved.remove.mockResolvedValueOnce(false);
  await renderServer();
  await pressButton("Remove two.example.test");
  expect(container?.textContent).toContain("Could not remove the server");
  saved.remove.mockImplementationOnce(async () => {
    saved.list = [];
    return true;
  });
  await pressButton("Remove two.example.test");
  expect(container?.textContent).not.toContain("Could not remove the server");
});

it("does not switch to a server whose removal is still running, so it is not listed again", async () => {
  saved.list = [
    { apiBase: "https://two.example.test", headers: {} },
    { apiBase: "https://three.example.test", headers: {} },
  ];
  const removal = deferred<boolean>();
  saved.remove.mockReturnValueOnce(removal.promise);
  await renderServer();
  await pressButton("Remove two.example.test");
  await pressButton("two.example.test");
  expect(api.probe).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
  // A switch to another saved server cannot bring the removed one back, so it still runs.
  await pressButton("three.example.test");
  expect(api.save).toHaveBeenCalledWith("https://three.example.test", {});
  await act(async () => {
    removal.resolve(true);
    await flush();
  });
});

it("lets a switch run after a removal that failed", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  saved.remove.mockResolvedValueOnce(false);
  await renderServer();
  await pressButton("Remove two.example.test");
  expect(container?.textContent).toContain("Could not remove the server");
  await pressButton("two.example.test");
  expect(api.save).toHaveBeenCalledWith("https://two.example.test", {});
});

it("tells an http server from an https one on the same host", async () => {
  saved.list = [
    { apiBase: "http://10.0.0.8", headers: {} },
    { apiBase: "https://10.0.0.8", headers: {} },
  ];
  await renderServer();
  const labels = Array.from(container!.querySelectorAll("button")).map((node) => node.textContent);
  expect(labels).toContain("http://10.0.0.8");
  expect(labels).toContain("10.0.0.8");
});

it("announces a failed check once, with the words the screen shows", async () => {
  api.probe.mockResolvedValueOnce({ ok: false, error: "No server" });
  await renderServer("https://two.example.test");
  await pressSave();
  expect(container?.textContent).toContain("No server");
  expect(announce).toHaveBeenCalledExactlyOnceWith("No server");
});

it("announces a failed save", async () => {
  api.save.mockResolvedValueOnce({ ok: false, error: "Could not save the server" });
  await renderServer();
  await pressSave();
  expect(container?.textContent).toContain("Could not save the server");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not save the server");
});

it("announces a failed return to the default server", async () => {
  server.custom = true;
  api.reset.mockResolvedValueOnce({ ok: false, error: "Could not restore the default" });
  await renderServer();
  await pressButton("Use default server");
  expect(container?.textContent).toContain("Could not restore the default");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not restore the default");
});

it("announces a failed removal of a recent server", async () => {
  saved.list = [{ apiBase: "https://two.example.test", headers: {} }];
  saved.remove.mockResolvedValueOnce(false);
  await renderServer();
  await pressButton("Remove two.example.test");
  expect(container?.textContent).toContain("Could not remove the server");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not remove the server");
});

it("announces a repeated failure again", async () => {
  api.probe
    .mockResolvedValueOnce({ ok: false, error: "No server" })
    .mockResolvedValueOnce({ ok: false, error: "No server" });
  await renderServer("https://two.example.test");
  await pressSave();
  await pressSave();
  expect(announce).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenNthCalledWith(2, "No server");
});

it("announces nothing when the switch succeeds", async () => {
  await renderServer("https://two.example.test");
  await pressSave();
  expect(api.save).toHaveBeenCalled();
  expect(announce).not.toHaveBeenCalled();
});
