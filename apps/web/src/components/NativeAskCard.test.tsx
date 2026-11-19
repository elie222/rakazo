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
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));
vi.mock("./vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import type { AskBlock, AskCardProps } from "./messages/AskCard";
import { AskCard } from "./messages/AskCard";

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

async function render(block: AskBlock, onAnswer: AskCardProps["onAnswer"] = async () => undefined) {
  await act(async () =>
    root.render(
      <AskCard
        block={block}
        canAnswer
        canDismiss={false}
        onAnswer={onAnswer}
        onDismiss={async () => undefined}
      />,
    ),
  );
}

function button(name: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === name);
}

it("shows native delivery separately from submission and never approves an expired request", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const block: AskBlock = {
    kind: "ask",
    text: "Write file?",
    status: "pending",
    nativeRequestId: "native-approval",
    nativeKind: "permission",
    nativeDelivery: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  };
  await render(block, onAnswer);
  await act(async () => button("Allow once")!.click());
  expect(onAnswer).toHaveBeenCalledWith("allow");
  expect(container.querySelector("svg.lucide-check")).toBeNull();
  await render({ ...block, nativeDelivery: "submitted", answer: "allow" });
  expect(container.textContent).toContain("Sending…");
  expect(button("Allow once")).toBeUndefined();
  await render({ ...block, status: "answered", nativeDelivery: "expired", answer: "allow" });
  expect(container.textContent).toContain("No longer active");
  expect(container.textContent).not.toContain("Allowed once");
  await render({ ...block, status: "answered", nativeDelivery: "delivered", answer: "allow" });
  expect(container.textContent).toContain("Allowed once");
});

it("keeps a native question with allow and deny choices distinct from permission approval", async () => {
  await render({
    kind: "ask",
    text: "Which policy should the document describe?",
    status: "answered",
    nativeRequestId: "native-question",
    nativeKind: "question",
    nativeDelivery: "delivered",
    answer: "allow",
    actions: [
      { id: "allow", label: "Allow policy" },
      { id: "deny", label: "Deny policy" },
    ],
  });
  expect(container.textContent).not.toContain("Allowed once");
  expect(container.textContent).toContain("Allow policy");
});
