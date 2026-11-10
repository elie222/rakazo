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
  title: string;
  note: string;
  preview?: Record<string, unknown>;
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
  setOptions: vi.fn(),
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
  native: { tertiaryLabel: "tertiary-label" },
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
// The bots' addresses read on their own; this screen's tests cover the vault's items.
vi.mock("../components/bot-email", () => ({ BotEmailAddressesGroup: () => null }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => ({
  // Focus effects run while `state.focused` holds and clean up once a render clears it.
  useFocusEffect: (effect: () => undefined | (() => void)) =>
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId }),
  useNavigation: () => ({ setOptions: state.setOptions }),
}));
// Older iOS: New sits above the list in a native menu instead of the header.
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  Platform: { OS: "ios" },
  Pressable: element("span"),
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
vi.mock("../components/vault-tile", () => ({
  VaultTile: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android, color }: { ios: string; android: string; color: string }) =>
    createElement("i", { "data-ios": ios, "data-android": android, "data-color": color }),
}));
vi.mock("../components/list-search-input", () => ({
  ListSearchInput: ({ query, setQuery }: { query: string; setQuery: (query: string) => void }) =>
    createElement("input", {
      "aria-label": "Search",
      value: query,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "nav",
      null,
      options.map((option) =>
        createElement(
          "button",
          { key: option.value, type: "button", onClick: () => onChange(option.value) },
          option.label,
        ),
      ),
    ),
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
    createElement(
      "span",
      { role: "row", onClick: onPress },
      detail ? `${title}: ${detail}` : title,
    ),
}));
// The sheets are covered by their own components; here they report what they were opened for.
vi.mock("../components/vault-item-sheet", () => ({
  VaultItemSheet: ({
    item,
    billingTitle,
    onShow,
    onEdit,
    onRemove,
    onClose,
  }: {
    item: Credential;
    billingTitle?: string;
    onShow: () => void;
    onEdit: () => void;
    onRemove: () => void;
    onClose: () => void;
  }) =>
    createElement(
      "dialog",
      { open: true, "aria-label": `Detail ${item.name}`, "data-billing": billingTitle },
      ...[
        ["Show", onShow],
        ["Edit", onEdit],
        ["Remove", onRemove],
        ["Done", onClose],
      ].map(([label, onClick]) =>
        createElement("button", { key: label as string, type: "button", onClick }, label as string),
      ),
    ),
}));
vi.mock("../components/vault-item-editor", () => ({
  VaultItemEditor: ({
    kind,
    item,
    contacts,
    onClose,
    onSave,
  }: {
    kind: string;
    item?: Credential;
    contacts: { key: string; label: string }[];
    onClose: () => void;
    onSave: (save: unknown) => Promise<void>;
  }) => {
    const [failed, setFailed] = useState(false);
    return createElement(
      "dialog",
      {
        open: true,
        "aria-label": `Edit ${kind} ${item?.name ?? "new"}`,
        "data-contacts": contacts.map((contact) => contact.label).join(","),
      },
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave(
              item
                ? { destination: { name: item.name, auth: item.auth }, title: "Renamed", note: "" }
                : {
                    destination: { name: "netbird-key", auth: { type: "command" } },
                    value: "example-value",
                    title: "",
                    note: "",
                  },
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
  title: "api.github.com",
  note: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...change,
});
const variable = credential({
  name: "netbird-key",
  origin: "",
  auth: { type: "command" },
  title: "netbird-key",
});

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll('[role="row"]')].map((node) => node.textContent);
const row = (text: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="row"]')].find((node) =>
    node.textContent?.startsWith(text),
  )!;
const button = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
const menu = (name: string) => container.querySelector(`[aria-label="${name}"]`)!;
const dialog = () => container.querySelector("dialog")!;
type AlertButton = { text: string; style?: string; onPress?: () => void };
const alertButton = (text: string) =>
  (state.alert.mock.lastCall![2] as AlertButton[]).find((entry) => entry.text === text)!;

async function render() {
  await act(async () => root.render(createElement(Vault)));
}

async function open(title: string) {
  await act(async () => row(title).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.focused = true;
  state.alert.mockReset();
  state.actionSheet.mockReset();
  state.copy.mockClear();
  state.confirmIdentity.mockReset().mockResolvedValue(true);
  state.credentials = [credential({}), variable];
  state.rpc.mockReset().mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "vault/list") return state.credentials;
    if (proc === "vault/put") {
      const destination = input.destination as Credential;
      const saved = state.credentials.find((entry) => entry.name === destination.name);
      return saved
        ? { ...saved, title: input.title || saved.title }
        : credential({ ...destination, origin: destination.origin ?? "", title: destination.name });
    }
    if (proc === "vault/remove") return { ok: true };
    if (proc === "vault/reveal") {
      if (input.name === "example-login") {
        return {
          fields: [
            { label: "Email", value: "ada@example.test", hidden: false },
            { label: "Password", value: "example-password", hidden: true },
            { label: "PIN", value: "1234", hidden: true },
          ],
        };
      }
      if (input.name === "visa") {
        return { card: { number: "4242424242424242", expMonth: 8, expYear: 2028, cvc: "123" } };
      }
      return { value: "example-value" };
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

it("lists the account vault with each item's title and subtitle", async () => {
  await render();
  expect(state.rpc).toHaveBeenCalledWith("vault/list", { scope: "account" });
  expect(rows()).toEqual(["api.github.com: API key", "netbird-key: $NETBIRD_KEY"]);
  expect([...menu("New item").querySelectorAll("button")].map((node) => node.textContent)).toEqual([
    "Login",
    "Card",
    "Contact",
    "API key",
    "Variable",
  ]);
});

it("filters by kind only once there are two kinds, and searches only a long list", async () => {
  state.credentials = [credential({})];
  await render();
  expect(container.querySelector("nav")).toBeNull();
  expect(container.querySelector('input[aria-label="Search"]')).toBeNull();

  state.credentials = [
    variable,
    ...Array.from({ length: 7 }, (_, index) =>
      credential({ name: `key-${index}`, title: `Key ${index}` }),
    ),
  ];
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect([...container.querySelectorAll("nav button")].map((node) => node.textContent)).toEqual([
    "All",
    "Keys",
    "Variables",
  ]);
  await act(async () => button("Variables")!.click());
  expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
  expect(container.querySelector('input[aria-label="Search"]')).not.toBeNull();
});

it("edits a Space's own vault through that Space", async () => {
  state.spaceId = "space-work";
  await render();
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/list",
    { scope: "space" },
    { requestContext: { headers: { space: "space-work" } } },
  );

  await act(async () => button("Variable", menu("New item"))!.click());
  await act(async () => button("Save", dialog())!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/put",
    {
      scope: "space",
      destination: { name: "netbird-key", auth: { type: "command" } },
      value: "example-value",
      title: "",
      note: "",
    },
    { requestContext: { headers: { space: "space-work" } } },
  );
});

it("adds an item of the kind picked from New, and closes the editor once saved", async () => {
  state.credentials = [credential({})];
  await render();
  await act(async () => button("Card", menu("New item"))!.click());
  expect(container.querySelector('dialog[aria-label="Edit card new"]')).not.toBeNull();

  await act(async () => button("Save", dialog())!.click());
  expect(container.querySelector("dialog")).toBeNull();
  expect(rows()).toEqual(["api.github.com: API key", "netbird-key: $NETBIRD_KEY"]);
});

it("keeps the editor open when saving fails", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Login", menu("New item"))!.click());
  await act(async () => button("Save", dialog())!.click());
  expect(dialog().textContent).toContain("Failed");
});

it("opens an item's detail on tap, and edits it from there or from its menu", async () => {
  await render();
  await open("api.github.com");
  expect(container.querySelector('dialog[aria-label="Detail github"]')).not.toBeNull();
  await act(async () => button("Edit", dialog())!.click());
  expect(container.querySelector('dialog[aria-label="Edit api_key github"]')).not.toBeNull();
  await act(async () => button("Save", dialog())!.click());
  expect(state.rpc).toHaveBeenLastCalledWith("vault/put", {
    scope: "account",
    destination: { name: "github", auth: { type: "bearer" } },
    title: "Renamed",
    note: "",
  });
  expect(rows()[0]).toBe("Renamed: API key · api.github.com");

  await act(async () => button("Edit", menu("netbird-key"))!.click());
  expect(container.querySelector('dialog[aria-label="Edit variable netbird-key"]')).not.toBeNull();
});

it("offers saved contacts for a card's billing, and names a card's billing contact", async () => {
  state.credentials = [
    credential({ name: "home", origin: "", auth: { type: "contact" }, title: "Home" }),
    credential({
      name: "visa",
      origin: "",
      auth: { type: "card" },
      title: "Visa ·· 4242",
      preview: {
        card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2028, billing: "home" },
      },
    }),
  ];
  await render();
  await open("Visa");
  expect(dialog().dataset.billing).toBe("Home");
  await act(async () => button("Edit", dialog())!.click());
  expect(dialog().dataset.contacts).toBe("Home");
});

it("removes an item only once the destructive alert is confirmed", async () => {
  await render();
  const remove = button("Remove", menu("api.github.com"))!;
  expect(remove.dataset.destructive).toBe("true");

  await act(async () => remove.click());
  expect(state.alert).toHaveBeenCalledWith("Remove api.github.com?", undefined, expect.any(Array));
  expect(alertButton("Remove").style).toBe("destructive");
  await act(async () => alertButton("Cancel").onPress?.());
  expect(state.rpc).not.toHaveBeenCalledWith("vault/remove", expect.anything());

  await act(async () => alertButton("Remove").onPress?.());
  expect(state.rpc).toHaveBeenCalledWith("vault/remove", { scope: "account", name: "github" });
  expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
});

it("offers only removal for an item whose settings can't be read", async () => {
  state.credentials = [credential({ name: "legacy", title: "legacy", auth: null })];
  await render();
  expect(button("Edit", menu("legacy"))).toBeUndefined();
  expect(button("Remove", menu("legacy"))).toBeDefined();
});

it("shows an error when removing fails and keeps the item", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Remove", menu("api.github.com"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(container.textContent).toContain("Could not remove the item");
  expect(rows()).toContain("api.github.com: API key");
});

it("offers a retry when the vault fails to load", async () => {
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(rows()).toEqual([]);

  await act(async () => button("Something went wrong. Try again. Retry")!.click());
  expect(rows()).toHaveLength(2);
});

const identityRequired = () =>
  Object.assign(new Error("Confirm it's you"), { code: "IDENTITY_CONFIRMATION_REQUIRED" });

it("shows a value in a native alert with a copy action, and never on the screen", async () => {
  await render();
  await open("netbird-key");
  await act(async () => button("Show", dialog())!.click());
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
      title: "login.example.test",
    }),
  ];
  await render();
  await open("login.example.test");
  await act(async () => button("Show", dialog())!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "login.example.test",
    "Email\nada@example.test\n\nPassword\nexample-password\n\nPIN\n1234",
    expect.any(Array),
  );
  // Every field's copy goes in a sheet, which pages on Android instead of dropping buttons.
  await act(async () => alertButton("Copy").onPress?.());
  const sheet = state.actionSheet.mock.calls[0]![0] as {
    title: string;
    actions: { text: string; onPress: () => void }[];
  };
  expect(sheet.actions.map((action) => action.text)).toEqual([
    "Copy Email",
    "Copy Password",
    "Copy PIN",
  ]);
  for (const action of sheet.actions) await act(async () => action.onPress());
  expect(state.copy.mock.calls).toEqual([["ada@example.test"], ["example-password"], ["1234"]]);
});

it("shows a card's number, expiry and security code once revealed", async () => {
  state.credentials = [
    credential({ name: "visa", origin: "", auth: { type: "card" }, title: "Visa ·· 4242" }),
  ];
  await render();
  await open("Visa");
  await act(async () => button("Show", dialog())!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "Visa ·· 4242",
    "Card number\n4242424242424242\n\nExpires\n08/28\n\nSecurity code\n123",
    expect.any(Array),
  );
  expect(container.textContent).not.toContain("4242424242424242");
});

it("reveals a Space's own vault through that Space", async () => {
  state.spaceId = "space-work";
  await render();
  await open("api.github.com");
  await act(async () => button("Show", dialog())!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/reveal",
    { scope: "space", name: "github" },
    { requestContext: { headers: { space: "space-work" } } },
  );
});

it("confirms it's the person and retries once when the server asks", async () => {
  await render();
  await open("api.github.com");
  state.rpc.mockRejectedValueOnce(identityRequired());
  await act(async () => button("Show", dialog())!.click());
  expect(state.confirmIdentity).toHaveBeenCalledTimes(1);
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "vault/reveal")).toHaveLength(2);
  expect(state.alert).toHaveBeenCalledWith("api.github.com", "example-value", expect.any(Array));
});

it("shows nothing and no error when the confirmation is dismissed", async () => {
  await render();
  await open("api.github.com");
  state.confirmIdentity.mockResolvedValue(false);
  state.rpc.mockRejectedValueOnce(identityRequired());
  await act(async () => button("Show", dialog())!.click());
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "vault/reveal")).toHaveLength(1);
  expect(state.alert).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Could not show the item");
});

it("shows an error when revealing fails", async () => {
  await render();
  await open("api.github.com");
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Show", dialog())!.click());
  expect(state.alert).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not show the item");
});

it("drops a value that arrives once another screen covers this one", async () => {
  await render();
  await open("api.github.com");
  let finish!: (value: { value: string }) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => button("Show", dialog())!.click());
  state.focused = false;
  await render();
  await act(async () => finish({ value: "example-value" }));
  expect(state.alert).not.toHaveBeenCalled();

  state.focused = true;
  await render();
  await act(async () => button("Show", dialog())!.click());
  expect(state.alert).toHaveBeenCalledWith("api.github.com", "example-value", expect.any(Array));
});
