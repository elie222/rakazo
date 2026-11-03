// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Vault from "../app/(settings)/vault";

type Credential = {
  name: string;
  origin: string;
  auth: { type: string } | null;
  createdAt: string;
  updatedAt: string;
};
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  copy: vi.fn(async () => true),
  actionSheet: vi.fn(),
  confirmIdentity: vi.fn(async () => true),
  spaceId: undefined as string | undefined,
  focused: true,
  credentials: [] as Credential[],
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => ({
  // Focus effects run while `state.focused` holds and clean up once a render clears it.
  useFocusEffect: (effect: () => undefined | (() => void)) =>
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("p"),
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("expo-clipboard", () => ({ setStringAsync: state.copy }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: state.actionSheet }));
// The real retry rule from contracts, with the device prompt replaced by `confirmIdentity`.
vi.mock("../components/confirm-identity", async () => {
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => ({
      withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
        runWithIdentityConfirmation(action, state.confirmIdentity),
      identityDialog: null,
    }),
  };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; attributes?: { destructive?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-destructive": action.attributes?.destructive === true,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) =>
    createElement("button", { type: "button", onClick: onRetry }, `${message} Retry`),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    detail,
    onPress,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
  }) =>
    onPress
      ? createElement("button", { type: "button", onClick: onPress }, title)
      : createElement("span", null, detail ? `${title}: ${detail}` : title),
}));
// The sheet is covered by its own test; here it reports what it was opened for and saves a fixed
// destination, rejecting the way the real sheet expects when the save fails.
vi.mock("../components/vault-credential-sheet", () => ({
  VaultCredentialSheet: ({
    replacing,
    onClose,
    onSave,
  }: {
    replacing: Credential | null;
    onClose: () => void;
    onSave: (destination: unknown, value: string) => Promise<void>;
  }) => {
    const [failed, setFailed] = useState(false);
    return createElement(
      "dialog",
      { open: true, "aria-label": replacing ? `Replace ${replacing.name}` : "Add" },
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave(
              replacing
                ? { name: replacing.name, origin: replacing.origin, auth: replacing.auth }
                : { name: "netbird-key", auth: { type: "command" } },
              "example-value",
            ).then(onClose, () => setFailed(true)),
        },
        "Save",
      ),
      failed ? "Failed" : null,
    );
  },
}));

const credential = (change: Partial<Credential>): Credential => ({
  name: "github",
  origin: "https://api.github.com",
  auth: { type: "bearer" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...change,
});

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
const button = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
const menu = (name: string) => container.querySelector(`[aria-label="${name}"]`)!;
type AlertButton = { text: string; style?: string; onPress?: () => void };
const alertButton = (text: string) =>
  (state.alert.mock.lastCall![2] as AlertButton[]).find((entry) => entry.text === text)!;

async function render() {
  await act(async () => root.render(createElement(Vault)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.focused = true;
  state.alert.mockReset();
  state.actionSheet.mockReset();
  state.copy.mockClear();
  state.confirmIdentity.mockReset().mockResolvedValue(true);
  state.credentials = [
    credential({}),
    credential({ name: "netbird-key", origin: "", auth: { type: "command" } }),
  ];
  state.rpc.mockReset().mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "vault/list") return state.credentials;
    if (proc === "vault/put") {
      const destination = input.destination as Credential;
      return credential({ ...destination, origin: destination.origin ?? "" });
    }
    if (proc === "vault/remove") return { ok: true };
    if (proc === "vault/reveal") {
      return input.name === "example-login"
        ? {
            fields: [
              { label: "Email", value: "ada@example.test", hidden: false },
              { label: "Password", value: "example-password", hidden: true },
              { label: "PIN", value: "1234", hidden: true },
            ],
          }
        : { value: "example-value" };
    }
    throw new Error(`Unexpected RPC: ${proc}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists the account vault with each credential's site or command variable", async () => {
  await render();
  expect(state.rpc).toHaveBeenCalledWith("vault/list", { scope: "account" });
  expect(rows()).toEqual([
    "github: https://api.github.com",
    "netbird-key: Command variable $NETBIRD_KEY",
  ]);
  expect(button("Add credential")).toBeDefined();
});

it("edits a Space's own vault through that Space", async () => {
  state.spaceId = "space-work";
  await render();
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/list",
    { scope: "space" },
    { requestContext: { headers: { space: "space-work" } } },
  );

  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/put",
    {
      scope: "space",
      destination: { name: "netbird-key", auth: { type: "command" } },
      value: "example-value",
    },
    { requestContext: { headers: { space: "space-work" } } },
  );
});

it("adds a credential and closes the form once saved", async () => {
  state.credentials = [credential({})];
  await render();
  await act(async () => button("Add credential")!.click());
  expect(container.querySelector('dialog[aria-label="Add"]')).not.toBeNull();

  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.querySelector("dialog")).toBeNull();
  expect(rows()).toEqual([
    "github: https://api.github.com",
    "netbird-key: Command variable $NETBIRD_KEY",
  ]);
});

it("keeps the form open when saving fails", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.querySelector("dialog")?.textContent).toContain("Failed");
});

it("replaces a credential's value from its menu, keeping its site and type", async () => {
  await render();
  await act(async () => button("Replace value", menu("github"))!.click());
  expect(container.querySelector('dialog[aria-label="Replace github"]')).not.toBeNull();

  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(state.rpc).toHaveBeenLastCalledWith("vault/put", {
    scope: "account",
    destination: { name: "github", origin: "https://api.github.com", auth: { type: "bearer" } },
    value: "example-value",
  });
  expect(container.querySelector("dialog")).toBeNull();
});

it("removes a credential only once the destructive alert is confirmed", async () => {
  await render();
  const remove = button("Remove", menu("github"))!;
  expect(remove.dataset.destructive).toBe("true");

  await act(async () => remove.click());
  expect(state.alert).toHaveBeenCalledWith("Remove github?", undefined, expect.any(Array));
  expect(alertButton("Remove").style).toBe("destructive");
  await act(async () => alertButton("Cancel").onPress?.());
  expect(state.rpc).not.toHaveBeenCalledWith("vault/remove", expect.anything());

  await act(async () => alertButton("Remove").onPress?.());
  expect(state.rpc).toHaveBeenCalledWith("vault/remove", { scope: "account", name: "github" });
  expect(rows()).toEqual(["netbird-key: Command variable $NETBIRD_KEY"]);
});

it("offers only removal for a credential whose settings can't be read", async () => {
  state.credentials = [credential({ name: "legacy", auth: null })];
  await render();
  expect(button("Replace value", menu("legacy"))).toBeUndefined();
  expect(button("Show", menu("legacy"))).toBeUndefined();
  expect(button("Remove", menu("legacy"))).toBeDefined();
});

it("shows an error when removing fails and keeps the credential", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Remove", menu("github"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(container.textContent).toContain("Could not remove the credential");
  expect(rows()).toContain("github: https://api.github.com");
});

it("offers a retry when the vault fails to load", async () => {
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(button("Add credential")).toBeUndefined();

  await act(async () => button("Something went wrong. Try again. Retry")!.click());
  expect(rows()).toHaveLength(2);
});

it("clears a failed removal's error once a later save succeeds", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Remove", menu("github"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(container.textContent).toContain("Could not remove the credential");

  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.textContent).not.toContain("Could not remove the credential");
});

const identityRequired = () =>
  Object.assign(new Error("Confirm it's you"), { code: "IDENTITY_CONFIRMATION_REQUIRED" });

it("shows a value in a native alert with a copy action, and never on the screen", async () => {
  await render();
  await act(async () => button("Show", menu("netbird-key"))!.click());
  expect(state.rpc).toHaveBeenCalledWith("vault/reveal", { scope: "account", name: "netbird-key" });
  expect(state.alert).toHaveBeenCalledWith("netbird-key", "example-value", expect.any(Array));
  expect(container.textContent).not.toContain("example-value");

  await act(async () => alertButton("Copy").onPress?.());
  expect(state.copy).toHaveBeenCalledWith("example-value");
  expect(alertButton("Done").style).toBe("cancel");
});

it("shows each field of a website login under its label, each with its own copy", async () => {
  state.credentials = [
    credential({
      name: "example-login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    }),
  ];
  await render();
  await act(async () => button("Show", menu("example-login"))!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "example-login",
    "Email\nada@example.test\n\nPassword\nexample-password\n\nPIN\n1234",
    expect.any(Array),
  );
  expect(alertButton("Done").style).toBe("cancel");
  // Every field's copy goes in a sheet, which pages on Android instead of dropping buttons.
  await act(async () => alertButton("Copy").onPress?.());
  const sheet = state.actionSheet.mock.calls[0]![0] as {
    title: string;
    actions: { text: string; onPress: () => void }[];
  };
  expect(sheet.title).toBe("example-login");
  expect(sheet.actions.map((action) => action.text)).toEqual([
    "Copy Email",
    "Copy Password",
    "Copy PIN",
  ]);
  for (const action of sheet.actions) await act(async () => action.onPress());
  expect(state.copy.mock.calls).toEqual([["ada@example.test"], ["example-password"], ["1234"]]);
});

it("reveals a Space's own vault through that Space", async () => {
  state.spaceId = "space-work";
  await render();
  await act(async () => button("Show", menu("github"))!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/reveal",
    { scope: "space", name: "github" },
    { requestContext: { headers: { space: "space-work" } } },
  );
});

it("confirms it's the person and retries once when the server asks", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(identityRequired());
  await act(async () => button("Show", menu("github"))!.click());
  expect(state.confirmIdentity).toHaveBeenCalledTimes(1);
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "vault/reveal")).toHaveLength(2);
  expect(state.alert).toHaveBeenCalledWith("github", "example-value", expect.any(Array));
});

it("shows nothing and no error when the confirmation is dismissed", async () => {
  await render();
  state.confirmIdentity.mockResolvedValue(false);
  state.rpc.mockRejectedValueOnce(identityRequired());
  await act(async () => button("Show", menu("github"))!.click());
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "vault/reveal")).toHaveLength(1);
  expect(state.alert).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Could not show the credential");
});

it("shows an error when revealing fails", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Show", menu("github"))!.click());
  expect(state.alert).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not show the credential");
});

it("drops a value that arrives once another screen covers this one", async () => {
  await render();
  let finish!: (value: { value: string }) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => button("Show", menu("github"))!.click());
  state.focused = false;
  await render();
  await act(async () => finish({ value: "example-value" }));
  expect(state.alert).not.toHaveBeenCalled();

  // Back in focus, Show works again.
  state.focused = true;
  await render();
  await act(async () => button("Show", menu("github"))!.click());
  expect(state.alert).toHaveBeenCalledWith("github", "example-value", expect.any(Array));
});
