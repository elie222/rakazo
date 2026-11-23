// @vitest-environment jsdom

import type { BotSecretMetadata, VaultRevealed } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lingui macros need a transform that unit tests do not run, so supply `t` and `Trans` here.
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
// Bots and activity load their own data; the rows under test don't depend on either.
vi.mock("./VaultItemAccess", () => ({ useVaultBots: () => undefined }));
vi.mock("./VaultItemActivity", () => ({
  VaultItemActivity: () => null,
  VaultItemUses: () => null,
}));

import { VaultItemDetail } from "./VaultItemDetail";

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderItem(
  row: BotSecretMetadata,
  onReveal: () => Promise<VaultRevealed | null> = async () => null,
) {
  await act(async () => {
    root.render(
      <VaultItemDetail
        scope="account"
        ownVault={false}
        item={row}
        contactTitles={new Map()}
        busy={false}
        error={null}
        onClose={vi.fn()}
        onReveal={onReveal}
        onEdit={vi.fn()}
        onRemove={vi.fn(async () => false)}
      />,
    );
  });
}

/** What a screen reader announces after the name "Copy" of each copy button, in page order. */
function copyDescriptions() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy"]')).map(
    (button) =>
      (button.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim(),
  );
}

describe("VaultItemDetail Copy buttons", () => {
  it("describes each login Copy button by its row's label", async () => {
    await renderItem(
      item({
        name: "github",
        title: "github.com",
        origin: "https://github.com",
        auth: { type: "login" },
        preview: { username: "octo@example.com" },
      }),
    );

    expect(copyDescriptions()).toEqual(["Site", "Username"]);
  });

  it("describes each revealed card Copy button by its own row", async () => {
    const onReveal = vi.fn(
      async (): Promise<VaultRevealed> => ({
        card: {
          number: "4242424242424242",
          expMonth: 8,
          expYear: 2030,
          cvc: "123",
          name: "Alex Rivera",
        },
      }),
    );
    await renderItem(
      item({
        name: "visa",
        title: "Visa ·· 4242",
        auth: { type: "card" },
        preview: {
          card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030, name: "Alex Rivera" },
        },
      }),
      onReveal,
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="vault-item-show"]')!.click();
    });

    expect(copyDescriptions()).toEqual(["Number", "Expires", "Security code", "Name on card"]);
  });

  it("describes each contact Copy button by its row's label", async () => {
    await renderItem(
      item({
        name: "home",
        title: "Home",
        auth: { type: "contact" },
        preview: {
          contact: {
            name: "Alex Rivera",
            line1: "1 Main Street",
            city: "Springfield",
            phone: "+1 555 0100",
            email: "alex@example.com",
          },
        } as BotSecretMetadata["preview"],
      }),
    );

    expect(copyDescriptions()).toEqual(["Full name", "Address", "Phone", "Email"]);
  });
});
