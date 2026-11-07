// @vitest-environment jsdom

import type { BotSecretMetadata, SettingsScope } from "@rakazo/contracts";
import { encodeCardSecret, encodeLoginSecret } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  list: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  reveal: vi.fn(),
}));
// No bot has an email address unless a test gives it one.
const bots = vi.hoisted(() => ({ emailAddresses: vi.fn(async (): Promise<unknown> => null) }));

// The dialog itself is tested on its own; here it is a pair of buttons that settle it.
vi.mock("./ConfirmIdentityDialog", async () => {
  const { useState } = await import("react");
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => {
      const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
      const done = (confirmed: boolean) => {
        settle?.(confirmed);
        setSettle(null);
      };
      return {
        withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
          runWithIdentityConfirmation(
            action,
            () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
          ),
        identityDialog: settle ? (
          <div data-testid="identity-dialog">
            <button type="button" data-testid="identity-confirm" onClick={() => done(true)} />
            <button type="button" data-testid="identity-cancel" onClick={() => done(false)} />
          </div>
        ) : null,
      };
    },
  };
});

vi.mock("../lib/rpc", () => ({
  rpc: { vault, bots },
  rpcForSpace: () => ({ vault, bots }),
  createSpaceRpc: () => ({ vault, bots }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { REVEAL_MS, VaultSettings } from "./VaultSettings";

const FAKE_VALUE = "fake-value-SENTINEL-1";
const stamp = "2026-09-01T00:00:00.000Z";
const item = (row: Partial<BotSecretMetadata> & Pick<BotSecretMetadata, "name" | "auth">) =>
  ({
    origin: "",
    title: row.name,
    note: "",
    createdAt: stamp,
    updatedAt: stamp,
    ...row,
  }) as BotSecretMetadata;
const rows: BotSecretMetadata[] = [
  item({
    name: "github",
    title: "github.com",
    origin: "https://github.com",
    auth: { type: "login" },
    preview: { username: "octo@example.com" },
  }),
  item({
    name: "visa",
    title: "Visa ·· 4242",
    note: "For travel",
    auth: { type: "card" },
    preview: {
      card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030, billing: "home" },
    },
  }),
  item({
    name: "home",
    title: "Home",
    auth: { type: "contact" },
    preview: {
      contact: { name: "Alex Rivera", city: "Springfield", phone: "+1 555 0100" },
    } as BotSecretMetadata["preview"],
  }),
  item({
    name: "custom",
    title: "svc.example.com",
    origin: "https://svc.example.com",
    auth: { type: "header", name: "X-Api-Key" },
  }),
  item({ name: "deploy-token", auth: { type: "command" } }),
];

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(scope: SettingsScope = "account") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <VaultSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function find<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

function byTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const found = find<T>(testId);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found;
}

async function click(target: string | HTMLElement) {
  await act(async () => {
    (typeof target === "string" ? byTestId(target) : target).click();
  });
  await flush();
}

function rowNamed(name: string) {
  return document.querySelector<HTMLElement>(
    `[data-testid="vault-credential-row"][data-name="${name}"]`,
  )!;
}

function editor() {
  return find("vault-editor");
}

function detail() {
  return find("vault-item-detail");
}

/** The editor's field labelled `label`, found through its label as a person would. */
function field(label: string, within: HTMLElement | null = editor()) {
  const labelled = [...(within?.querySelectorAll("label") ?? [])].find(
    (item) => item.textContent === label,
  );
  if (!labelled) throw new Error(`Missing field: ${label}`);
  return document.getElementById(labelled.htmlFor) as HTMLInputElement | HTMLSelectElement;
}

async function type(target: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

function buttonIn(within: HTMLElement | null, name: string) {
  return [...(within?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name);
}

/** Opens New and picks a kind from its menu. */
async function startNew(kind: string) {
  await click("vault-new");
  await click(`vault-new-${kind}`);
  expect(editor()).not.toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vault.list.mockReset().mockResolvedValue(rows);
  vault.put.mockReset().mockResolvedValue(rows[0]);
  vault.remove.mockReset().mockResolvedValue({ ok: true });
  vault.reveal.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VaultSettings list", () => {
  it("shows each item's title and what tells it apart, never a value", async () => {
    await render();
    expect(
      [...document.querySelectorAll('[data-testid="vault-credential-row"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "Ggithub.comocto@example.com",
      "Visa ·· 4242Expires 08/30 · For travel",
      "HomeAlex Rivera · Springfield",
      "svc.example.comAPI key",
      "deploy-token$DEPLOY_TOKEN",
    ]);
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "account" });
  });

  it("shows only New until there is something to list", async () => {
    vault.list.mockResolvedValue([]);
    await render();
    expect(find("vault-new")).not.toBeNull();
    expect(find("vault-card")).toBeNull();
    expect(find("vault-filter-all")).toBeNull();
  });

  it("lists the bots' email addresses in the account's vault only", async () => {
    vault.list.mockResolvedValue([]);
    bots.emailAddresses.mockResolvedValue({
      domain: "bots.test",
      addresses: [{ botId: "bot-1", botName: "Scout", address: "scout@bots.test" }],
    });
    await render("space");
    expect(find("vault-bot-emails")).toBeNull();

    await render();
    expect(byTestId("vault-bot-emails").textContent).toContain("scout@bots.test");
    expect(document.querySelector('button[aria-label="Copy scout@bots.test"]')).not.toBeNull();
  });

  it("filters by kind once there are two kinds, and searches once there are many", async () => {
    vault.list.mockResolvedValue(rows.slice(0, 1));
    await render();
    expect(find("vault-filter-all")).toBeNull();
    expect(document.querySelector('input[aria-label="Search Vault"]')).toBeNull();

    vault.list.mockResolvedValue(rows);
    await act(async () => root.unmount());
    root = createRoot(container);
    queryClient.clear();
    await render();
    expect(byTestId("vault-filter-all").textContent).toBe("All5");
    expect(byTestId("vault-filter-card").textContent).toBe("Cards1");
    await click("vault-filter-card");
    expect(byTestId("vault-filter-card").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll('[data-testid="vault-credential-row"]')).toHaveLength(1);
    expect(rowNamed("visa")).not.toBeNull();

    const many = Array.from({ length: 8 }, (_, index) =>
      item({ name: `key-${index}`, title: `Key ${index}`, auth: { type: "command" } }),
    );
    vault.list.mockResolvedValue(many);
    await act(async () => root.unmount());
    root = createRoot(container);
    queryClient.clear();
    await render();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search Vault"]')!;
    await type(search, "key 3");
    expect(
      [...document.querySelectorAll('[data-testid="vault-credential-row"]')].map((row) =>
        row.getAttribute("data-name"),
      ),
    ).toEqual(["key-3"]);
  });

  it("reads and writes the Space's own vault when scoped to the Space", async () => {
    await render("space");
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "space" });
    await click(rowNamed("deploy-token"));
    await click("vault-item-remove");
    await click("vault-item-remove-confirm");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "space", name: "deploy-token" });
  });
});

describe("VaultSettings new items", () => {
  it("saves a card as one encoded value, named by the server and billed to a contact", async () => {
    await render();
    await startNew("card");
    await type(field("Card number"), "4242 4242 4242 4242");
    expect(byTestId("vault-card-brand").textContent).toBe("Visa");
    await type(field("Expiry"), "08/30");
    await type(field("Security code"), "123");
    await type(field("Billing address"), "home");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: undefined, origin: "", auth: { type: "card" } },
      value: encodeCardSecret({
        number: "4242424242424242",
        expMonth: 8,
        expYear: 2030,
        cvc: "123",
        billing: "home",
      }),
    });
    expect(vault.list).toHaveBeenCalledTimes(2);
    expect(editor()).toBeNull();
  });

  it("saves a contact under its label, with a note added on request", async () => {
    await render();
    await startNew("contact");
    await type(field("Label"), "Office");
    await type(field("Address"), "1 Main St");
    await click(buttonIn(editor(), "Add a note")!);
    await type(field("When to use"), "Deliveries");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: undefined, origin: "", auth: { type: "contact" } },
      value: JSON.stringify({ line1: "1 Main St" }),
      title: "Office",
      note: "Deliveries",
    });
  });

  it("encodes a website login's fields, and can't save until each has a label and value", async () => {
    await render();
    await startNew("login");
    await type(field("Site"), "https://portal.example.com");
    const values = editor()!.querySelectorAll<HTMLInputElement>(
      '[data-testid="login-field"] input:not([aria-label="Label"])',
    );
    await type(values[0]!, "jamie");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    await type(values[1]!, FAKE_VALUE);
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: undefined,
        origin: "https://portal.example.com",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({
        fields: [
          { label: "Username", value: "jamie", hidden: false },
          { label: "Password", value: FAKE_VALUE, hidden: true },
        ],
      }),
    });
  });

  it("adds a header credential, clears the value, and shows the server's error", async () => {
    vault.put.mockRejectedValueOnce(new Error("Credential limit reached"));
    await render();
    await startNew("api_key");
    await type(field("Site"), "https://api.example.com");
    await type(field("Type"), "header");
    await type(field("Header name"), "X-Api-Key");
    await type(field("Value"), FAKE_VALUE);
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: undefined,
        origin: "https://api.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      value: FAKE_VALUE,
    });
    expect(editor()?.textContent).toContain("Credential limit reached");
    expect((field("Value") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("names a variable as it is exported, and refuses a reserved one", async () => {
    await render();
    await startNew("variable");
    await type(field("Variable name"), "PATH");
    await type(field("Value"), FAKE_VALUE);
    expect(byTestId("vault-editor-variable-error").textContent).toContain("$PATH is reserved");
    expect(buttonIn(editor(), "Save")!.disabled).toBe(true);
    await type(field("Variable name"), "NETBIRD_SETUP_KEY");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird_setup_key", origin: "", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
  });
});

describe("VaultSettings item details", () => {
  const confirmationRequired = Object.assign(new Error("Confirm it's you"), {
    code: "IDENTITY_CONFIRMATION_REQUIRED",
  });

  it("shows a contact in full and a card's billing contact by its title", async () => {
    await render();
    await click(rowNamed("home"));
    expect(detail()?.textContent).toContain("Alex Rivera");
    expect(detail()?.textContent).toContain("+1 555 0100");
    expect(vault.reveal).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click(rowNamed("visa"));
    expect(detail()?.textContent).toContain("•••• 4242");
    expect(detail()?.textContent).toContain("Billing addressHome");
    expect(detail()?.textContent).toContain("For travel");
  });

  it("shows a value after the person confirms it's them, and hides it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vault.reveal
      .mockRejectedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ value: FAKE_VALUE });
    await render();
    await click(rowNamed("custom"));
    expect(detail()?.textContent).toContain('Header "X-Api-Key"');
    await click("vault-item-show");
    await click("identity-confirm");
    expect(vault.reveal).toHaveBeenCalledWith({ scope: "account", name: "custom" });
    expect(byTestId("vault-item-value").textContent).toContain(FAKE_VALUE);
    // A shown value never lands in the query cache.
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    expect(JSON.stringify(cached)).not.toContain(FAKE_VALUE);
    await act(async () => {
      byTestId("vault-item-value").querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(FAKE_VALUE);
    await act(async () => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows nothing and no error when the confirmation is dismissed", async () => {
    vault.reveal.mockRejectedValueOnce(confirmationRequired);
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-show");
    await click("identity-cancel");
    expect(detail()?.querySelector('[role="alert"]')).toBeNull();
    expect(byTestId("vault-item-value").textContent).toContain("••••");
  });

  it("shows each field of a website login with its label", async () => {
    vault.reveal.mockResolvedValue({
      fields: [
        { label: "Username", value: "jamie", hidden: false },
        { label: "PIN", value: FAKE_VALUE, hidden: true },
      ],
    });
    await render();
    await click(rowNamed("github"));
    await click("vault-item-show");
    expect(
      [...document.querySelectorAll('[data-testid="vault-item-field"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["Usernamejamie", `PIN${FAKE_VALUE}`]);
  });

  it("edits a card from its revealed value", async () => {
    vault.reveal.mockResolvedValue({
      card: { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123" },
    });
    await render();
    await click(rowNamed("visa"));
    await click("vault-item-edit");
    expect(detail()).toBeNull();
    expect((field("Expiry") as HTMLInputElement).value).toBe("08/30");
    await type(field("Name"), "Travel card");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "visa", origin: "", auth: { type: "card" } },
      value: encodeCardSecret({
        number: "4242424242424242",
        expMonth: 8,
        expYear: 2030,
        cvc: "123",
      }),
      title: "Travel card",
      note: "For travel",
    });
  });

  it("keeps a key's saved value when an edit leaves it empty", async () => {
    await render();
    await click(rowNamed("custom"));
    await click("vault-item-edit");
    expect((field("Site") as HTMLInputElement).disabled).toBe(true);
    await type(field("Name"), "Service");
    await click(buttonIn(editor(), "Save")!);
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "custom",
        origin: "https://svc.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      title: "Service",
      note: "",
    });
  });

  it("removes only after an explicit confirm", async () => {
    await render();
    await click(rowNamed("deploy-token"));
    await click("vault-item-remove");
    expect(vault.remove).not.toHaveBeenCalled();
    expect(detail()?.textContent).toContain("Remove deploy-token?");
    await click("vault-item-remove-confirm");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "deploy-token" });
    expect(detail()).toBeNull();
  });

  it("offers only Remove on an item whose saved settings can't be read", async () => {
    vault.list.mockResolvedValue([
      item({ name: "broken", auth: null }),
      item({ name: "Legacy Name", origin: "https://x.example.com", auth: { type: "bearer" } }),
    ]);
    await render();
    expect(rowNamed("broken").textContent).toContain("can't be read");
    for (const name of ["broken", "Legacy Name"]) {
      await click(rowNamed(name));
      expect(find("vault-item-edit")).toBeNull();
      expect(find("vault-item-show")).toBeNull();
      expect(find("vault-item-remove")).not.toBeNull();
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
    }
  });
});
