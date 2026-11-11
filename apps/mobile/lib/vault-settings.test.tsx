// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Vault from "../app/(settings)/vault";
import { resetI18nForTests } from "./i18n";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);

type Credential = {
  name: string;
  origin: string;
  auth: { type: string } | null;
  title: string;
  note: string;
  preview?: Record<string, unknown>;
  alsoOn?: string[];
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
  spaces: [] as { id: string }[],
  overrides: [] as string[],
  setOptions: vi.fn(),
  pickCsv: vi.fn(),
  ios26: false,
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
// Client copy passes through, as it does in the app; anything else reads as the fallback.
const clientCopy = "Update your server to import logins.";
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message === clientCopy ? clientCopy : fallback,
}));
// The bots' addresses read on their own; this screen's tests cover the vault's items.
vi.mock("../components/bot-email", () => ({ BotEmailAddressesGroup: () => null }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => {
  // The same object on every render, as the app's navigation is.
  const navigation = { setOptions: (options: unknown) => state.setOptions(options) };
  return {
    // Focus effects run while `state.focused` holds and clean up once a render clears it.
    useFocusEffect: (effect: () => undefined | (() => void)) =>
      useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]),
    useLocalSearchParams: () => ({ spaceId: state.spaceId }),
    useNavigation: () => navigation,
  };
});
// Older iOS unless a test says otherwise: New sits above the list in a native menu instead of
// the header.
vi.mock("./native-controls", () => ({ iosAtLeast: () => state.ios26 }));
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
vi.mock("./vault-import", () => ({ pickVaultCsv: state.pickCsv }));
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
    actions: {
      id: string;
      title: string;
      attributes?: { destructive?: boolean; disabled?: boolean };
    }[];
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
            disabled: action.attributes?.disabled === true,
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
  SettingsFooter: element("small"),
  SettingsGroup: ({
    label,
    footer,
    children,
  }: {
    label?: string;
    footer?: string;
    children: ReactNode;
  }) => createElement("section", { "aria-label": label }, children, footer),
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
    uses,
    notice,
    onShow,
    onEdit,
    onRemove,
    onClose,
  }: {
    item: Credential;
    billingTitle?: string;
    uses: Array<{ botName: string }>;
    notice?: string;
    onShow: () => void;
    onEdit: () => void;
    onRemove: () => void;
    onClose: () => void;
  }) =>
    createElement(
      "dialog",
      {
        open: true,
        "aria-label": `Detail ${item.name}`,
        "data-billing": billingTitle,
        "data-uses": uses.map((use) => use.botName).join(","),
        "data-notice": notice,
      },
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
    bots,
    botsNote,
    onClose,
    onSave,
  }: {
    kind: string;
    item?: Credential;
    contacts: { key: string; label: string }[];
    bots?: { name: string }[];
    botsNote?: string;
    onClose: () => void;
    onSave: (save: unknown, policy?: unknown, access?: unknown) => Promise<void>;
  }) => {
    const [failed, setFailed] = useState(false);
    const [saved, setSaved] = useState(false);
    const save = item
      ? { destination: { name: item.name, auth: item.auth }, title: "Renamed", note: "" }
      : {
          destination: { name: "netbird-key", auth: { type: "command" } },
          value: "example-value",
          title: "",
          note: "",
        };
    return createElement(
      "dialog",
      {
        open: true,
        "aria-label": `Edit ${kind} ${item?.name ?? "new"}`,
        "data-contacts": contacts.map((contact) => contact.label).join(","),
        "data-bots": bots ? bots.map((bot) => bot.name).join(",") : "none",
        "data-bots-note": botsNote,
      },
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave(save, undefined, { allBots: false, botIds: ["bot-1"] }).then(
              () => setSaved(true),
              () => setFailed(true),
            ),
        },
        "Chosen",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave(save, "ask").then(
              () => setSaved(true),
              () => setFailed(true),
            ),
        },
        "Ask first",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => onSave(save).then(onClose, () => setFailed(true)),
        },
        "Save",
      ),
      createElement(
        "button",
        {
          type: "button",
          // Closes only on Close, as the real sheet closes after its save, a frame later.
          onClick: () =>
            onSave(save, "off").then(
              () => setSaved(true),
              () => setFailed(true),
            ),
        },
        "Block",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave({
              destination: { origin: "https://shop.example.com", auth: { type: "login" } },
              value: JSON.stringify({
                fields: [{ label: "Password", value: "fake-pass", hidden: true }],
                otp: TEST_KEY,
              }),
              alsoOn: ["https://www.shop.example.com"],
            }).then(
              () => setSaved(true),
              () => setFailed(true),
            ),
        },
        "Save key",
      ),
      saved ? createElement("button", { type: "button", onClick: onClose }, "Close") : null,
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
  resetI18nForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.ios26 = false;
  state.focused = true;
  state.alert.mockReset();
  state.actionSheet.mockReset();
  state.copy.mockClear();
  state.confirmIdentity.mockReset().mockResolvedValue(true);
  state.credentials = [credential({}), variable];
  state.spaces = [{ id: "space-1" }];
  state.overrides = [];
  state.rpc.mockReset().mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "vault/list") return state.credentials;
    // Keeps what it is told, as the server does, so a read after a change finds it.
    if (proc === "vault/put") {
      const destination = input.destination as Credential;
      const saved = state.credentials.find((entry) => entry.name === destination.name);
      const next = saved
        ? { ...saved, title: (input.title as string) || saved.title }
        : credential({ ...destination, origin: destination.origin ?? "", title: destination.name });
      state.credentials = saved
        ? state.credentials.map((entry) => (entry === saved ? next : entry))
        : [...state.credentials, next];
      return next;
    }
    if (proc === "vault/remove") {
      state.credentials = state.credentials.filter((entry) => entry.name !== input.name);
      return { ok: true };
    }
    if (proc === "vault/activity")
      return input.name === "github" ? [{ botName: "Research bot" }, { botName: "Helper" }] : [];
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
    if (proc === "spaces/list") return { spaces: state.spaces };
    if (proc === "spaceSettings/overrides") return state.overrides;
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
    "Import CSV",
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
  expect(state.rpc).toHaveBeenLastCalledWith("vault/list", { scope: "account" });
  expect(rows()).toEqual(["api.github.com: API key", "netbird-key: $NETBIRD_KEY"]);
});

it("keeps the editor open when saving fails", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Login", menu("New item"))!.click());
  await act(async () => button("Save", dialog())!.click());
  expect(dialog().textContent).toContain("Failed");
});

it("saves a new item with Block, and opens it saying an older server dropped the Block", async () => {
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  await act(async () => button("Block", dialog())!.click());
  const puts = state.rpc.mock.calls.filter(([procedure]) => procedure === "vault/put");
  expect(puts).toEqual([
    [
      "vault/put",
      {
        scope: "account",
        destination: { name: "netbird-key", auth: { type: "command" } },
        value: "example-value",
        title: "",
        note: "",
        policy: "off",
      },
    ],
  ]);
  // The saved item came back without the setting. Its sheet waits for the editor to go, then
  // opens with the notice: never two sheets at once.
  const detail = () => container.querySelector('dialog[aria-label="Detail netbird-key"]');
  expect(detail()).toBeNull();
  await act(async () => button("Close", dialog())!.click());
  expect(container.querySelector('dialog[aria-label^="Edit"]')).toBeNull();
  expect(detail()?.getAttribute("data-notice")).toBe(
    "Saved, but this server can't block bots yet.",
  );
  // The notice belongs to that save: a later open of the item doesn't repeat it.
  await act(async () => button("Edit", dialog())!.click());
  await act(async () => button("Save", dialog())!.click());
  await open("Renamed");
  expect(detail()?.getAttribute("data-notice")).toBeNull();
});

it("offers the owner's bots once the server keeps a choice, and says when it didn't", async () => {
  state.credentials = state.credentials.map((entry) => ({ ...entry, allBots: true, botIds: [] }));
  const listBots = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "bots/list")
      return [
        { id: "bot-1", name: "Ada", archivedAt: null },
        { id: "bot-old", name: "Old", archivedAt: "2026-10-01T00:00:00.000Z" },
      ];
    if (proc === "spaceSettings/overrides") return state.overrides;
    if (proc === "spaces/list") return { spaces: state.spaces };
    if (proc === "vault/put") {
      // An older server saves the item and drops the bots chosen for it.
      const {
        allBots: _,
        botIds: __,
        ...saved
      } = (await listBots(proc, input)) as Credential & {
        allBots?: boolean;
        botIds?: string[];
      };
      return saved;
    }
    return listBots(proc, input);
  });
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada");
  await act(async () => button("Chosen", dialog())!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/put",
    expect.objectContaining({ allBots: false, botIds: ["bot-1"] }),
  );
  await act(async () => button("Close", dialog())!.click());
  expect(
    container.querySelector('dialog[aria-label="Detail netbird-key"]')?.getAttribute("data-notice"),
  ).toBe("Saved, but this server can't limit an item to chosen bots.");
});

it("reads the owner's bots again for each edit", async () => {
  state.credentials = state.credentials.map((entry) => ({ ...entry, allBots: true, botIds: [] }));
  let bots = [{ id: "bot-1", name: "Ada", archivedAt: null }];
  const vaultRpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "bots/list" ? bots : vaultRpc(proc, input),
  );
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada");
  await act(async () => button("Save", dialog())!.click());
  bots = [...bots, { id: "bot-2", name: "Grace", archivedAt: null }];
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada,Grace");
});

it("offers an archived bot that is still chosen, so it can be let go of", async () => {
  state.credentials = state.credentials.map((entry) =>
    entry.name === "netbird-key"
      ? { ...entry, allBots: false, botIds: ["bot-old"] }
      : { ...entry, allBots: true, botIds: [] },
  );
  const vaultRpc = state.rpc.getMockImplementation()!;
  const archivedAt = "2026-10-01T00:00:00.000Z";
  // As the server lists them: archived bots only in their own list.
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "bots/list"
      ? [{ id: "bot-1", name: "Ada", archivedAt: null }]
      : proc === "bots/listArchived"
        ? [
            { id: "bot-old", name: "Old", archivedAt },
            { id: "bot-gone", name: "Gone", archivedAt },
          ]
        : vaultRpc(proc, input),
  );
  await render();
  await act(async () => button("Edit", menu("netbird-key"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada,Old · Archived");
});

it("offers every bot of a shared Space, one another member made too", async () => {
  state.credentials = state.credentials.map((entry) => ({ ...entry, allBots: true, botIds: [] }));
  const vaultRpc = state.rpc.getMockImplementation()!;
  // Ada is this member's bot; Grace was made by another member of the Space.
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "bots/list"
      ? [
          { id: "bot-1", name: "Ada", archivedAt: null },
          { id: "bot-2", name: "Grace", archivedAt: null },
        ]
      : vaultRpc(proc, input),
  );
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada,Grace");
});

it("asks for Ask first by name, and says when the server didn't keep it", async () => {
  await render();
  expect(state.rpc).toHaveBeenCalledWith("vault/list", { scope: "account" });
  // A server from before Ask first drops it.
  const vaultRpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    const result = await vaultRpc(proc, input);
    if (proc !== "vault/put") return result;
    const { policy: _, ...saved } = result as { policy?: string };
    return saved;
  });
  await act(async () => button("Variable", menu("New item"))!.click());
  await act(async () => button("Ask first", dialog())!.click());
  const puts = state.rpc.mock.calls.filter(([proc]) => proc === "vault/put");
  expect(puts.map(([, input]) => (input as { policy?: string }).policy)).toEqual(["ask"]);
  await act(async () => button("Close", dialog())!.click());
  expect(
    container.querySelector('dialog[aria-label="Detail netbird-key"]')?.getAttribute("data-notice"),
  ).toBe("Saved, but this server can't ask you first.");
});

it("says an account item's other Spaces choose their own bots, and offers none from a Space with its own vault", async () => {
  state.credentials = state.credentials.map((entry) => ({ ...entry, allBots: true, botIds: [] }));
  const vaultRpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "bots/list" ? [{ id: "bot-1", name: "Ada", archivedAt: null }] : vaultRpc(proc, input),
  );
  state.spaces = [{ id: "space-1" }, { id: "space-2" }];
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("Ada");
  expect(dialog().getAttribute("data-bots-note")).toBe(
    "This limits only this Space's bots. Your other Spaces choose for their own.",
  );
  act(() => root.unmount());
  root = createRoot(container);
  state.overrides = ["credentials"];
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("none");
  expect(dialog().getAttribute("data-bots-note")).toBe(
    "This Space keeps its own vault, so its bots can't use account items.",
  );
});

it("offers no bots for an account item until it knows whether this Space keeps its own vault", async () => {
  state.credentials = state.credentials.map((entry) => ({ ...entry, allBots: true, botIds: [] }));
  const vaultRpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "bots/list"
      ? [{ id: "bot-1", name: "Ada", archivedAt: null }]
      : proc === "spaceSettings/overrides"
        ? new Promise(() => {})
        : vaultRpc(proc, input),
  );
  await render();
  await act(async () => button("Edit", menu("netbird-key"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("none");
  await act(async () => button("Save", dialog())!.click());
  const put = state.rpc.mock.calls.findLast(([proc]) => proc === "vault/put")?.[1];
  expect(put).toBeDefined();
  expect(put).not.toHaveProperty("allBots");
  expect(put).not.toHaveProperty("botIds");
});

it("offers no choice of bots when the saved items show the server can't keep one", async () => {
  await render();
  await act(async () => button("Variable", menu("New item"))!.click());
  expect(dialog().getAttribute("data-bots")).toBe("none");
  expect(state.rpc).not.toHaveBeenCalledWith("bots/list");
});

it("opens a saved login saying an older server kept neither its other sites nor its key", async () => {
  // An older server reads the saved login back as a preview, without the key.
  const rpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc !== "vault/put") return rpc(proc, input);
    const saved = credential({ name: "shop", auth: { type: "login" }, preview: {} });
    state.credentials = [...state.credentials, saved];
    return saved;
  });
  await render();
  await act(async () => button("Login", menu("New item"))!.click());
  await act(async () => button("Save key", dialog())!.click());
  await act(async () => button("Close", dialog())!.click());
  expect(container.querySelector("dialog[aria-label^='Detail']")?.getAttribute("data-notice")).toBe(
    "Saved, but this server fills logins only on their own site. Saved, but this server can't keep authenticator keys yet.",
  );
});

it("says nothing of the key when the saved login's preview couldn't be read", async () => {
  // A server that keeps keys and other sites, whose read of the saved value failed for now.
  const rpc = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "vault/put"
      ? credential({
          name: "shop",
          auth: { type: "login" },
          alsoOn: ["https://www.shop.example.com"],
        })
      : rpc(proc, input),
  );
  await render();
  await act(async () => button("Login", menu("New item"))!.click());
  await act(async () => button("Save key", dialog())!.click());
  await act(async () => button("Close", dialog())!.click());
  // No notice, so the saved login doesn't open by itself.
  expect(
    container.querySelector("dialog[aria-label^='Detail']")?.getAttribute("data-notice"),
  ).toBeUndefined();
});

it("opens an item's detail on tap, and edits it from there or from its menu", async () => {
  await render();
  await open("api.github.com");
  expect(container.querySelector('dialog[aria-label="Detail github"]')).not.toBeNull();
  expect(state.rpc).toHaveBeenCalledWith("vault/activity", { scope: "account", name: "github" });
  expect(dialog()?.getAttribute("data-uses")).toBe("Research bot,Helper");
  await act(async () => button("Edit", dialog())!.click());
  expect(container.querySelector('dialog[aria-label="Edit api_key github"]')).not.toBeNull();
  await act(async () => button("Save", dialog())!.click());
  expect(state.rpc).toHaveBeenCalledWith("vault/put", {
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

it("never shows an item's earlier uses once reading them again fails", async () => {
  await render();
  await open("api.github.com");
  expect(dialog()?.getAttribute("data-uses")).toBe("Research bot,Helper");
  await act(async () => button("Done", dialog())!.click());
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await open("api.github.com");
  expect(dialog()?.getAttribute("data-uses")).toBe("");
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
  expect(state.rpc).toHaveBeenLastCalledWith("vault/list", { scope: "account" });
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

it("shows a login's authenticator key with its fields, with its own copy of the key alone", async () => {
  // Copied as it was saved, here its setup link, never with its label.
  const otp = `otpauth://totp/GitHub:octo?secret=${TEST_KEY}&issuer=GitHub`;
  state.credentials = [
    credential({
      name: "keyed-login",
      origin: "https://login.example.test",
      alsoOn: ["https://www.login.example.test"],
      auth: { type: "login" },
      title: "login.example.test",
      preview: { username: "octo@example.com", otp: true },
    }),
  ];
  const fields = [
    { label: "Username", value: "octo@example.com", hidden: false },
    { label: "Password", value: "example-password", hidden: true },
  ];
  const list = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) =>
    proc === "vault/reveal" ? { fields, otp } : list(proc, input),
  );
  await render();
  await open("login.example.test");
  // Each hidden row's Show reveals the whole login, the key's row included, as on the web.
  const shows = [...dialog().querySelectorAll("button")].filter(
    (node) => node.textContent === "Show",
  );
  await act(async () => shows.at(-1)!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "login.example.test",
    `Username\nocto@example.com\n\nPassword\nexample-password\n\nAuthenticator key\n${otp}`,
    expect.any(Array),
  );
  // Shown only in the alert, never on the screen behind it.
  expect(container.textContent).not.toContain("GEZDGNBVGY3TQOJQ");
  await act(async () => alertButton("Copy").onPress?.());
  const sheet = state.actionSheet.mock.calls[0]![0] as {
    actions: { text: string; onPress: () => void }[];
  };
  expect(sheet.actions.map((action) => action.text)).toEqual([
    "Copy Username",
    "Copy Password",
    "Copy Authenticator key",
  ]);
  await act(async () => sheet.actions.at(-1)!.onPress());
  expect(state.copy.mock.calls).toEqual([[otp]]);
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

it("reviews a picked CSV export, imports only new logins and reminds to delete the file", async () => {
  state.credentials = [
    credential({
      name: "shop",
      origin: "https://shop.example.com",
      auth: { type: "login" },
      preview: { username: "alice" },
    }),
  ];
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [
      { ...login, username: "alice" },
      { ...login, username: "bob" },
    ],
    lines: [2, 3],
    skipped: { notHttps: 1, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [{ line: 1, label: "Old", reason: "notHttps" }],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  // Which rows were left out, by row and site, never by username or password.
  const left = "Row 1 · Old · Not on an HTTPS site\nRow 2 · shop.example.com · Already saved";
  expect(state.alert.mock.lastCall?.[1]).toBe(
    `To add: 1\nAlready saved: 1\nNot on an HTTPS site: 1\n\n${left}`,
  );
  state.rpc.mockImplementationOnce(async () => ({
    added: 1,
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    notSaved: [],
  }));
  await act(async () => alertButton("Import").onPress?.());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/import",
    { scope: "account", rows: [{ ...login, username: "bob" }] },
    // Longer than the usual call: a full vault's import takes seconds.
    { timeoutMs: 120_000 },
  );
  expect(state.alert.mock.lastCall?.[1]).toBe(
    `Added: 1\nAlready saved: 1\nNot on an HTTPS site: 1\n\n${left}\n\nDelete the exported file now. It holds your passwords unencrypted.`,
  );
});

it("lists left-out rows with the wording and limit both apps share", async () => {
  // A locale no catalog ships, so only these two strings change.
  i18n.load("en-XA", { "Row {line}": "Zeile {line}", "And {more} more": "Und {more} weitere" });
  i18n.activate("en-XA");
  state.pickCsv.mockResolvedValue({
    rows: [],
    lines: [],
    skipped: { notHttps: 7, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: Array.from({ length: 7 }, (_, index) => ({
      line: index + 1,
      label: `Old ${index}`,
      reason: "notHttps",
    })),
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  expect(state.alert.mock.lastCall?.[1]).toContain(
    [
      ...[0, 1, 2, 3, 4].map((index) => `Zeile ${index + 1} · Old ${index} · Not on an HTTPS site`),
      "Und 2 weitere",
    ].join("\n"),
  );
});

it("drops an import's result that arrives once another screen covers this one", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  let finish!: (value: unknown) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const review = state.alert.mock.calls.length;
  const imported = alertButton("Import").onPress?.();
  state.focused = false;
  await render();
  await act(async () => {
    finish({
      added: 1,
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
      notSaved: [],
    });
    await imported;
  });
  expect(state.alert).toHaveBeenCalledTimes(review);
});

it("keeps an item removed while the list is read after an import", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => ({
    added: 1,
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    notSaved: [],
  }));
  // The list read after it, from before the removal below.
  const stale = state.credentials;
  let listed!: () => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        listed = () => resolve(stale);
      }),
  );
  let imported!: Promise<void> | void;
  await act(async () => {
    imported = alertButton("Import").onPress?.();
  });
  await act(async () => button("Remove", menu("api.github.com"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
  await act(async () => {
    listed();
    await imported;
  });
  expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
});

// Everything the screen holds belongs to the one vault it shows. When it comes to show another
// vault it starts over, so nothing read, saved or failed for the first one is shown as the
// second's, whatever was on its way: an import, or the list read after it. An import that ends
// once the first vault's screen is gone reads that list no more.
it.each([
  ["the import", "saves", "isn't read"],
  ["the import", "fails", "isn't read"],
  ["the read after it", "saves", "is read"],
  ["the read after it", "saves", "can't be read"],
] as const)(
  "starts over for another vault shown during %s, which %s before the first one's list %s",
  async (during, importing, reading) => {
    const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
    state.pickCsv.mockResolvedValue({
      rows: [{ ...login, username: "bob" }],
      lines: [1],
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
      problems: [],
    });
    await render();
    await act(async () => button("Import CSV", menu("New item"))!.click());
    const account = state.credentials;
    const waits: (() => void)[] = [];
    const later = <T,>(answer: () => T) =>
      state.rpc.mockImplementationOnce(
        () =>
          new Promise<T>((resolve, reject) => {
            waits.push(() => {
              try {
                resolve(answer());
              } catch (error) {
                reject(error);
              }
            });
          }),
      );
    const imported = () => {
      if (importing === "fails") throw new Error("Internal server error");
      return {
        added: 1,
        skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
        notSaved: [],
      };
    };
    // The account's list, read after the import.
    const read = () =>
      later(() => {
        if (reading === "is read") return account;
        throw new Error("offline");
      });
    if (during === "the import") later(imported);
    else {
      state.rpc.mockImplementationOnce(async () => imported());
      read();
    }
    let saving!: Promise<void> | void;
    await act(async () => {
      saving = alertButton("Import").onPress?.();
    });
    // The Space's vault, its list still on its way: the account's is not shown as its own, and
    // nothing can be added or imported against it.
    state.spaceId = "space-work";
    state.credentials = [variable];
    let listed!: () => void;
    state.rpc.mockImplementationOnce(
      () => new Promise((resolve) => (listed = () => resolve(state.credentials))),
    );
    await render();
    expect(rows()).toEqual([]);
    expect(menu("New item")).toBeNull();
    await act(async () => listed());
    expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
    const alerts = state.alert.mock.calls.length;
    const lists = () => state.rpc.mock.calls.filter(([proc]) => proc === "vault/list").length;
    const readsBefore = lists();
    await act(async () => {
      waits.shift()!();
      await saving;
    });
    expect(lists()).toBe(readsBefore);
    expect(rows()).toEqual(["netbird-key: $NETBIRD_KEY"]);
    expect(state.alert.mock.calls).toHaveLength(alerts);
    expect(container.textContent).not.toContain("Something went wrong.");
    expect(container.textContent).not.toContain("Could not import");
    expect(button("Import CSV", menu("New item"))?.disabled).toBe(false);
  },
);

it("reads the list again when an import's read was out across a save, and shows both", async () => {
  state.credentials = [credential({})];
  state.pickCsv.mockResolvedValue({
    rows: [
      { title: "", origin: "https://shop.example.com", password: "fake-pass", username: "bob" },
    ],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  const server = state.rpc.getMockImplementation()!;
  await render();
  await act(async () => button("Card", menu("New item"))!.click());
  // The save reaches the server only once let go.
  let saved!: () => void;
  state.rpc.mockImplementationOnce(
    (proc: string, input: Record<string, unknown>) =>
      new Promise((resolve) => (saved = () => resolve(server(proc, input)))),
  );
  await act(async () => button("Save", dialog())!.click());
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => {
    state.credentials = [...state.credentials, credential({ name: "shop", title: "shop" })];
    return {
      added: 1,
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
      notSaved: [],
    };
  });
  // Each list read answers with the list as it was when sent, once let go.
  const reads: (() => void)[] = [];
  const read = () =>
    state.rpc.mockImplementationOnce(async (proc: string, input: Record<string, unknown>) => {
      const list = await server(proc, input);
      return new Promise((resolve) => reads.push(() => resolve(list)));
    });
  read();
  read();
  await act(async () => void alertButton("Import").onPress?.());
  expect(reads).toHaveLength(1);
  await act(async () => saved());
  const shown = rows();
  expect(shown.join()).toContain("netbird-key");
  // Read before the save reached the server: dropped, and read again.
  await act(async () => reads[0]!());
  expect(rows()).toEqual(shown);
  expect(reads).toHaveLength(2);
  await act(async () => reads[1]!());
  expect(rows()).toHaveLength(3);
  expect(rows().join()).toContain("shop");
  expect(rows().join()).toContain("netbird-key");
  expect(button("Import CSV", menu("New item"))?.disabled).toBe(false);
});

// A change counts as finished before the list is read after it, so each change is followed by
// one read of the list, never by one that is dropped and sent again.
it.each(["an item is saved", "an item is removed", "an import saves", "an import fails"] as const)(
  "reads the list once after %s",
  async (change) => {
    state.pickCsv.mockResolvedValue({
      rows: [
        { title: "", origin: "https://shop.example.com", password: "fake-pass", username: "bob" },
      ],
      lines: [1],
      skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
      problems: [],
    });
    await render();
    const lists = () => state.rpc.mock.calls.filter(([proc]) => proc === "vault/list").length;
    const before = lists();
    if (change === "an item is saved") {
      await act(async () => button("Card", menu("New item"))!.click());
      await act(async () => button("Save", dialog())!.click());
    } else if (change === "an item is removed") {
      await act(async () => button("Remove", menu("api.github.com"))!.click());
      await act(async () => alertButton("Remove").onPress?.());
    } else {
      await act(async () => button("Import CSV", menu("New item"))!.click());
      state.rpc.mockImplementationOnce(async () => {
        if (change === "an import fails") throw new Error("Internal server error");
        return {
          added: 1,
          skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
          notSaved: [],
        };
      });
      await act(async () => void alertButton("Import").onPress?.());
    }
    expect(lists()).toBe(before + 1);
  },
);

// Whenever the list can't be read, the screen offers Retry, read or not before; once Retry reads
// it, the error goes and Import CSV is on again.
it.each([
  "the screen is first shown",
  "the screen is shown again",
  "an item is saved",
  "an item is removed",
  "an import saves",
  "an import fails",
] as const)("offers Retry when the list can't be read after %s", async (after) => {
  state.pickCsv.mockResolvedValue({
    rows: [
      { title: "", origin: "https://shop.example.com", password: "fake-pass", username: "bob" },
    ],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  const server = state.rpc.getMockImplementation()!;
  let failList = after === "the screen is first shown";
  state.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "vault/list" && failList) {
      failList = false;
      throw new Error("offline");
    }
    return server(proc, input);
  });
  await render();
  if (after === "the screen is shown again") {
    state.focused = false;
    await render();
    failList = true;
    state.focused = true;
    await render();
  } else if (after === "an item is saved") {
    await act(async () => button("Card", menu("New item"))!.click());
    failList = true;
    await act(async () => button("Save", dialog())!.click());
  } else if (after === "an item is removed") {
    await act(async () => button("Remove", menu("api.github.com"))!.click());
    failList = true;
    await act(async () => alertButton("Remove").onPress?.());
  } else if (after !== "the screen is first shown") {
    await act(async () => button("Import CSV", menu("New item"))!.click());
    state.rpc.mockImplementationOnce(async () => {
      if (after === "an import fails") throw new Error("Internal server error");
      return {
        added: 1,
        skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
        notSaved: [],
      };
    });
    failList = true;
    await act(async () => void alertButton("Import").onPress?.());
  }
  expect(failList).toBe(false);
  if (after === "an import fails")
    expect(container.textContent).toContain("Importing the file again skips them.");
  await act(async () => button("Something went wrong. Try again. Retry")!.click());
  expect(state.rpc).toHaveBeenLastCalledWith("vault/list", { scope: "account" });
  expect(container.textContent).not.toContain("Something went wrong.");
  expect(button("Import CSV", menu("New item"))?.disabled).toBe(false);
});

it("shows a finished import's result even when the list can't be read after it", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => ({
    added: 1,
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    notSaved: [],
  }));
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await act(async () => alertButton("Import").onPress?.());
  expect(state.alert.mock.lastCall?.[1]).toContain("Added: 1");
  expect(state.alert.mock.lastCall?.[1]).toContain("Delete the exported file now.");
  expect(container.textContent).not.toContain("Could not import");
});

it("says how many logins look past the room left, and sends them all for the server to judge", async () => {
  state.credentials = Array.from({ length: 98 }, (_, index) =>
    credential({ name: `key-${index}`, title: `Key ${index}` }),
  );
  const login = { title: "", password: "fake-pass", username: "bob" };
  state.pickCsv.mockResolvedValue({
    rows: [1, 2, 3].map((index) => ({ ...login, origin: `https://s${index}.example.com` })),
    lines: [1, 2, 3],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  const review = state.alert.mock.lastCall?.[1] as string;
  expect(review).toContain("To add: 2\nVault full: 1");
  state.rpc.mockImplementationOnce(async () => ({
    added: 2,
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 1 },
    notSaved: [{ index: 2, reason: "limit" }],
  }));
  await act(async () => alertButton("Import").onPress?.());
  expect(state.rpc.mock.calls.find(([proc]) => proc === "vault/import")?.[1].rows).toHaveLength(3);
  expect(state.alert.mock.lastCall?.[1]).toContain("Row 3 · s3.example.com · Vault full");
  expect(review).not.toContain("Your Vault holds");
});

it("says an import that stopped partway may have saved some", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("Internal server error");
  });
  await act(async () => alertButton("Import").onPress?.());
  expect(container.textContent).toContain(
    "Could not import\nSome logins may have been saved. Importing the file again skips them.",
  );
});

it("offers Import CSV again only once the Vault is read after a failed import", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("Internal server error");
  });
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await act(async () => alertButton("Import").onPress?.());
  expect(container.textContent).toContain("Some logins may have been saved.");
  // The list it would plan against may lack what was saved, so a new review waits for it.
  state.pickCsv.mockClear();
  expect(button("Import CSV", menu("New item"))?.disabled).toBe(true);
  expect(state.pickCsv).not.toHaveBeenCalled();
});

it("turns the header's Import CSV on once the Vault is read, and off after a failed read", async () => {
  state.ios26 = true;
  type HeaderItem = { label: string; disabled?: boolean; onPress?: () => void };
  const importItem = () => {
    const options = state.setOptions.mock.lastCall?.[0] as {
      unstable_headerRightItems: () => { menu: { items: HeaderItem[] } }[];
    };
    return options
      .unstable_headerRightItems()[0]!
      .menu.items.find((item) => item.label === "Import CSV")!;
  };
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  expect(importItem().disabled).toBe(false);
  await act(async () => importItem().onPress?.());
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("Internal server error");
  });
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await act(async () => alertButton("Import").onPress?.());
  expect(importItem().disabled).toBe(true);
});

it("asks to update a server that can't import, which saved none", async () => {
  const login = { title: "", origin: "https://shop.example.com", password: "fake-pass" };
  state.pickCsv.mockResolvedValue({
    rows: [{ ...login, username: "bob" }],
    lines: [1],
    skipped: { notHttps: 0, noPassword: 0, duplicate: 0, invalid: 0, limit: 0 },
    problems: [],
  });
  await render();
  await act(async () => button("Import CSV", menu("New item"))!.click());
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("Update your server to import logins.");
  });
  await act(async () => alertButton("Import").onPress?.());
  expect(container.textContent).toContain("Update your server to import logins.");
  expect(container.textContent).not.toContain("Some logins may have been saved.");
});
