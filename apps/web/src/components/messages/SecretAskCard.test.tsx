// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
// A card's editor lists the vault's saved contacts; these cards need none.
vi.mock("../vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import type { AskBlock } from "./AskCard";
import { SecretAskCard } from "./SecretAskCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const secretCard: AskBlock = {
  kind: "ask",
  text: "API key",
  input: "secret",
  purpose: "api_key",
  credential: { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
  status: "pending",
};

async function render(
  onAnswer: () => Promise<void>,
  onDismiss: () => Promise<void> = async () => undefined,
) {
  await act(async () =>
    root.render(
      <SecretAskCard
        block={secretCard}
        canAnswer
        canDismiss
        onAnswer={onAnswer}
        onDismiss={onDismiss}
      />,
    ),
  );
}

function button(name: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === name);
}

function alert() {
  return container.querySelector('[role="alert"]');
}

async function type(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("announces a failed inline answer and clears the typed value", async () => {
  await render(async () => {
    throw new Error("server detail");
  });
  expect(alert()?.textContent).toBe("");

  await type("example-key");
  await act(async () => button("Save")!.click());

  expect(alert()?.textContent).toBe("Could not submit this answer");
  expect(container.textContent).not.toContain("server detail");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="API key"]')!.value).toBe("");
});

it("announces a failed dismissal", async () => {
  await render(
    async () => undefined,
    async () => {
      throw new Error("server detail");
    },
  );

  expect(alert()?.textContent).toBe("");
  await act(async () => button("Dismiss")!.click());

  expect(alert()?.textContent).toBe("Could not submit this answer");
  expect(container.textContent).not.toContain("server detail");
});

it("announces a second failure in a row", async () => {
  const onAnswer = vi.fn(async () => {
    throw new Error("offline");
  });
  await render(onAnswer);

  await type("first-key");
  await act(async () => button("Save")!.click());
  expect(alert()?.textContent).toBe("Could not submit this answer");

  await type("second-key");
  await act(async () => button("Save")!.click());

  expect(onAnswer).toHaveBeenCalledTimes(2);
  expect(alert()?.textContent).toBe("Could not submit this answer");
});
