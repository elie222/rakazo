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

import { ChoiceCard } from "../pages/shell/message-cards";
import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

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
  block: AskBlock,
  onDismiss: () => Promise<void> = async () => undefined,
  onAnswer: (text: string, username?: string) => Promise<void> = async () => undefined,
) {
  await act(async () =>
    root.render(
      <AskCard block={block} canAnswer canDismiss onAnswer={onAnswer} onDismiss={onDismiss} />,
    ),
  );
}

function button(name: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === name);
}

async function type(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("dismisses a secret card without sending the typed value", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onDismiss = vi.fn(async () => undefined);
  await render(secretCard, onDismiss, onAnswer);
  await type("API key", "example-key");

  await act(async () => button("Dismiss")!.click());

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledWith();
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Dismissed");
  expect(button("Dismiss")).toBeUndefined();
  expect(container.querySelector("input")).toBeNull();
});

it("shows a generic error when dismissing fails", async () => {
  await render(secretCard, async () => {
    throw new Error("server detail");
  });

  await act(async () => button("Dismiss")!.click());

  expect(container.textContent).toContain("Could not submit this answer");
  expect(container.textContent).not.toContain("server detail");
  expect(button("Dismiss")!.disabled).toBe(false);
});

it("shows a dismissed secret card as Dismissed, not Saved", async () => {
  await render({ ...secretCard, status: "answered", answer: "", dismissed: true });
  expect(container.textContent).toContain("Dismissed");
  expect(container.textContent).not.toContain("Saved");
  expect(button("Dismiss")).toBeUndefined();

  await render({ ...secretCard, status: "answered", answer: "" });
  expect(container.textContent).toContain("Saved");
  const card = container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(card.classList.contains("w-full")).toBe(true);
  expect(card.classList.contains("max-w-xl")).toBe(false);
});

it("offers Dismiss only on secret cards", async () => {
  await render({ kind: "ask", text: "Which city?", status: "pending" });
  expect(button("Dismiss")).toBeUndefined();
});

it("puts primary Save before equal-width secondary Dismiss", async () => {
  await render(secretCard);
  expect(
    [...button("Save")!.parentElement!.querySelectorAll("button")].map((item) => item.textContent),
  ).toEqual(["Save", "Dismiss"]);
  expect(button("Save")?.classList.contains("bg-primary")).toBe(true);
  expect(button("Dismiss")?.classList.contains("border-border")).toBe(true);
  expect(button("Save")!.disabled).toBe(true);
  expect(container.querySelector("input")?.classList.contains("w-full")).toBe(true);
  const card = container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(card.classList.contains("w-full")).toBe(true);
  expect(card.classList.contains("max-w-xl")).toBe(false);
  for (const label of ["Save", "Dismiss"]) {
    expect(button(label)?.classList.contains("flex-1")).toBe(true);
    expect(button(label)?.classList.contains("whitespace-normal")).toBe(true);
  }
  await type("API key", "example-key");
  expect(button("Save")!.disabled).toBe(false);
});

it("styles dismissed secrets like denied approvals, apart from the destination", async () => {
  await render({ ...secretCard, status: "answered", dismissed: true });
  const dismissed = [...container.querySelectorAll("div")].find(
    (item) => item.textContent === "Dismissed",
  )!;
  expect(dismissed.classList.contains("font-medium")).toBe(true);
  expect(dismissed.classList.contains("mt-3.5")).toBe(true);
  expect(dismissed.classList.contains("text-muted-foreground")).toBe(true);
});

for (const input of ["secret", "login"]) {
  it.each([true, false])(`gates only ${input} dismissal: %s`, async (canDismiss) => {
    const block = {
      kind: "ask" as const,
      text: "Secret",
      input: "secret" as const,
      status: "pending" as const,
      ...(input === "login"
        ? {
            credential: {
              name: "example",
              origin: "https://example.test",
              auth: { type: "login" as const },
            },
          }
        : {}),
    };
    await act(async () =>
      root.render(
        <AskCard
          block={block}
          canAnswer
          canDismiss={canDismiss}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
        />,
      ),
    );
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels.includes("Dismiss")).toBe(canDismiss);
    // A login is filled in only by the run's user; see the credential card test below.
    if (input === "login" && !canDismiss) return;
    expect(labels.includes("Save")).toBe(true);
    expect(button("Save")?.classList.contains("flex-1")).toBe(true);
  });
}

it("keeps an accepted secret Save answered without a block update", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(secretCard, undefined, onAnswer);
  await type("API key", "example-key");

  await act(async () => button("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("example-key", undefined);
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).not.toContain("example-key");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".text-destructive")).toBeNull();
});

it("keeps an accepted question choice answered until the block updates", async () => {
  const block: AskBlock = {
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [
      { id: "paris", label: "Paris" },
      { id: "london", label: "London" },
    ],
  };
  const onAnswer = vi.fn(async () => undefined);
  await render(block, undefined, onAnswer);

  await act(async () => button("Paris")!.click());

  expect(onAnswer).toHaveBeenCalledWith("paris", undefined);
  expect(container.textContent).toContain("Answered: Paris");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".text-destructive")).toBeNull();

  await render({ ...block, status: "answered", answer: "london" });
  expect(container.textContent).toContain("Answered: London");
  expect(container.textContent).not.toContain("Answered: Paris");
});

it("gives question options a fill and border", async () => {
  await render({
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [{ id: "paris", label: "Paris" }],
  });
  const option = button("Paris")!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("bg-secondary")).toBe(true);
  expect(option.classList.contains("border-input")).toBe(true);
});

it("gives onboarding choices borderless rows and distinct interaction states", async () => {
  await act(async () =>
    root.render(
      <ChoiceCard
        botId="bot"
        block={{
          kind: "choice",
          question: "Which city?",
          options: [{ id: "paris", letter: "A", label: "Paris" }],
        }}
        onBotChanged={async () => {}}
      />,
    ),
  );
  const option = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Paris"),
  )!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("bg-background")).toBe(true);
  expect(option.classList.contains("border")).toBe(false);
  expect(option.classList.contains("border-input")).toBe(false);
  expect(option.classList.contains("enabled:hover:bg-foreground/5")).toBe(true);
  expect(option.classList.contains("enabled:active:bg-foreground/15")).toBe(true);
  expect(option.classList.contains("focus-visible:ring-2")).toBe(true);
  expect(option.querySelector("span")?.classList.contains("bg-card")).toBe(true);
});

it.each([
  [
    "login",
    { name: "example_login", origin: "https://login.example.test", auth: { type: "login" } },
  ],
  ["API", { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } }],
] as const)(
  "shows a %s credential card read-only to anyone but the run's user",
  async (_name, credential) => {
    const render = (canDismiss: boolean) =>
      act(async () =>
        root.render(
          <AskCard
            block={{ kind: "ask", text: "Secret", input: "secret", status: "pending", credential }}
            canAnswer
            canDismiss={canDismiss}
            onAnswer={async () => {}}
            onDismiss={async () => {}}
          />,
        ),
      );

    await render(false);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain(credential.origin);
    expect(container.textContent).not.toContain("No longer active");

    await render(true);
    expect(container.querySelectorAll("input").length).toBeGreaterThan(0);
    expect(button("Save")).toBeDefined();
  },
);

it("keeps a connector code card open to others in the chat, without Dismiss", async () => {
  await act(async () =>
    root.render(
      <AskCard
        block={{ kind: "ask", text: "Code", input: "secret", purpose: "otp", status: "pending" }}
        canAnswer
        canDismiss={false}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    ),
  );
  expect(container.querySelector("input")).not.toBeNull();
  expect(button("Save")).toBeDefined();
  expect(button("Dismiss")).toBeUndefined();
});
