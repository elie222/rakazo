// @vitest-environment jsdom

import type { LoginFieldInput } from "@rakazo/contracts";
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
const rpc = vi.hoisted(() => ({ bots: { update: vi.fn(async () => ({})) } }));
vi.mock("../lib/rpc", () => ({ rpc }));

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
  onAnswer: (
    text: string,
    fields?: LoginFieldInput[],
    remember?: false,
  ) => Promise<void> = async () => undefined,
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
  expect(card.classList.contains("max-w-xl")).toBe(true);
});

it("offers Dismiss only on secret cards", async () => {
  await render({ kind: "ask", text: "Which city?", status: "pending" });
  expect(button("Dismiss")).toBeUndefined();
});

it("puts primary Save before secondary Dismiss at the default button size", async () => {
  await render(secretCard);
  expect(
    [...button("Save")!.parentElement!.querySelectorAll("button")].map((item) => item.textContent),
  ).toEqual(["Save", "Dismiss"]);
  expect(button("Save")?.classList.contains("bg-primary")).toBe(true);
  expect(button("Dismiss")?.classList.contains("border-border")).toBe(true);
  expect(button("Save")!.disabled).toBe(true);
  expect(container.querySelector("input")?.classList.contains("w-full")).toBe(true);
  const card = container.querySelector('[data-testid="secret-ask-card"]')!;
  expect(card.classList.contains("max-w-xl")).toBe(true);
  for (const label of ["Save", "Dismiss"]) {
    expect(button(label)?.classList.contains("h-8")).toBe(true);
    expect(button(label)?.classList.contains("flex-1")).toBe(false);
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
    expect(button("Save")?.classList.contains("h-8")).toBe(true);
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

const loginCard: AskBlock = {
  kind: "ask",
  text: "Sign in to Example",
  input: "secret",
  credential: {
    name: "example_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  },
  loginFields: ["ID number", "Phone number", "PIN"],
  status: "pending",
};

function loginInput(label: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function hiddenSwitch(label: string) {
  return [...container.querySelectorAll('[data-testid="login-field-value"]')]
    .find((row) => row.querySelector(`input[aria-label="${label}"]`))!
    .querySelector<HTMLElement>('[role="switch"]')!;
}

it("starts an ID and a phone visible and a PIN hidden, and the person can flip each", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);

  for (const [label, hidden] of [
    ["ID number", false],
    ["Phone number", false],
    ["PIN", true],
  ] as const) {
    expect(loginInput(label).type).toBe(hidden ? "password" : "text");
    expect(hiddenSwitch(label).getAttribute("aria-checked")).toBe(String(hidden));
    const description = hiddenSwitch(label).getAttribute("aria-describedby")!;
    expect(document.getElementById(description)?.textContent).toBe(label);
  }
  await type("ID number", " fake-id-123 ");
  await type("Phone number", "+1 555 0100");
  expect(button("Save")!.disabled).toBe(true);
  await type("PIN", "0000");
  await act(async () => hiddenSwitch("Phone number").click());
  expect(loginInput("Phone number").type).toBe("password");
  await act(async () => hiddenSwitch("PIN").click());
  expect(loginInput("PIN").type).toBe("text");

  await act(async () => button("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "ID number", value: " fake-id-123 ", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: true },
    { label: "PIN", value: "0000", hidden: false },
  ]);
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).not.toContain("fake-id-123");
  expect(container.querySelector("input")).toBeNull();
});

it("starts every field hidden when no label names an identifier", async () => {
  await render({ ...loginCard, loginFields: ["Memorable word", "Card number"] });

  for (const label of ["Memorable word", "Card number"]) {
    expect(loginInput(label).type).toBe("password");
    expect(hiddenSwitch(label).getAttribute("aria-checked")).toBe("true");
  }
});

it("asks for a visible username and a hidden password when the bot names no fields", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const { loginFields: _, ...defaultLogin } = loginCard;
  await render(defaultLogin, undefined, onAnswer);

  expect(
    [...container.querySelectorAll("input[aria-label]")].map((input) => input.ariaLabel),
  ).toEqual(["Username", "Password"]);
  expect(loginInput("Username").type).toBe("text");
  expect(hiddenSwitch("Username").getAttribute("aria-checked")).toBe("false");
  expect(loginInput("Password").type).toBe("password");
  expect(hiddenSwitch("Password").getAttribute("aria-checked")).toBe("true");
  await type("Username", "fake-user");
  await type("Password", "fake-password");
  await act(async () => button("Save")!.click());

  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "Username", value: "fake-user", hidden: false },
    { label: "Password", value: "fake-password", hidden: true },
  ]);
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

  await act(async () => button("AParis")!.click());

  expect(onAnswer).toHaveBeenCalledWith("paris", undefined);
  expect(container.textContent).not.toContain("Answered");
  expect(button("AParis")!.getAttribute("aria-pressed")).toBe("true");
  expect(button("BLondon")!.disabled).toBe(true);
  expect(container.querySelector(".text-destructive")).toBeNull();

  await render({ ...block, status: "answered", answer: "london" });
  expect(button("BLondon")!.getAttribute("aria-pressed")).toBe("true");
  expect(button("AParis")!.hasAttribute("aria-pressed")).toBe(false);
});

it("dims a closed question's options without a status line", async () => {
  await act(async () =>
    root.render(
      <AskCard
        block={{
          kind: "ask",
          text: "Which city?",
          status: "pending",
          actions: [{ id: "paris", label: "Paris" }],
        }}
        canAnswer={false}
        canDismiss={false}
        onAnswer={async () => undefined}
        onDismiss={async () => undefined}
      />,
    ),
  );
  expect(button("AParis")!.disabled).toBe(true);
  expect(container.textContent).not.toContain("No longer active");
});

it("letters question options and fills them only on hover", async () => {
  await render({
    kind: "ask",
    text: "Which city?",
    status: "pending",
    actions: [
      { id: "paris", label: "Paris" },
      { id: "london", label: "London" },
    ],
  });
  const option = button("BLondon")!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("bg-secondary")).toBe(false);
  expect(option.classList.contains("hover:bg-accent")).toBe(true);
  expect(option.querySelector("[aria-hidden]")?.textContent).toBe("B");
});

it("sizes approval buttons like the other card buttons", async () => {
  await render({
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Send it?",
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
  for (const label of ["Allow once", "Deny"]) {
    expect(button(label)?.classList.contains("min-h-8")).toBe(true);
    expect(button(label)?.classList.contains("py-3")).toBe(false);
  }
});

it.each(["Allow in this space", "Allow for this chat"])(
  "says a user's-computer approval labelled %s allows the whole space",
  async (label) => {
    const block: AskBlock = {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Run on your computer?",
      status: "pending",
      actions: [
        { id: "allow", label },
        { id: "deny", label: "Deny" },
      ],
    };
    await render({ ...block, detail: "hostname", detailFormat: "code" });
    const detail = container.querySelector('[data-testid="ask-detail"]');
    expect(detail?.textContent).toBe("hostname");
    // The card is muted, so the command sits on the page background to read as a snippet.
    expect(detail?.classList.contains("bg-background")).toBe(true);
    expect(detail?.classList.contains("bg-muted")).toBe(false);
    expect(button("Allow in this space")).toBeTruthy();
    expect(button("Allow once")).toBeUndefined();
    await render({ ...block, status: "answered", answer: "allow" });
    expect(container.textContent).toContain("Allowed in this space");
  },
);

it("gives onboarding choices the same lettered rows as questions", async () => {
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
  const option = button("AParis")!;
  expect(option.disabled).toBe(false);
  expect(option.classList.contains("hover:bg-accent")).toBe(true);
  expect(option.querySelector("[aria-hidden]")?.textContent).toBe("A");
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

function saveToVault() {
  return container.querySelector<HTMLElement>('[role="switch"]:not([aria-describedby])');
}

it("saves a login by default, with Save to Vault on and named by its label", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);
  const toggle = saveToVault()!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const label = toggle.getAttribute("aria-labelledby")!;
  expect(container.querySelector(`[id="${label}"]`)?.textContent).toBe("Save to Vault");
  await type("ID number", "fake-id-123");
  await type("Phone number", "+1 555 0100");
  await type("PIN", "1234");
  await act(async () => button("Save")!.click());

  // Nothing extra is sent, so the answer is saved as it always was.
  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "ID number", value: "fake-id-123", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: false },
    { label: "PIN", value: "1234", hidden: true },
  ]);
  expect(container.textContent).toContain("Saved");
});

it("sends a login for this run only when Save to Vault is off, and reads Sent", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginCard, undefined, onAnswer);
  await type("ID number", "fake-id-123");
  await act(async () => saveToVault()!.click());
  expect(saveToVault()!.getAttribute("aria-checked")).toBe("false");
  // Turning it off keeps what was typed and says the login is only sent on.
  expect(loginInput("ID number").value).toBe("fake-id-123");
  expect(button("Save")).toBeUndefined();
  await type("Phone number", "+1 555 0100");
  await type("PIN", "1234");
  await act(async () => button("Continue")!.click());

  expect(onAnswer).toHaveBeenCalledWith(
    "",
    [
      { label: "ID number", value: "fake-id-123", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: false },
      { label: "PIN", value: "1234", hidden: true },
    ],
    false,
  );
  expect(container.textContent).toContain("Sent");
  expect(container.textContent).not.toContain("Saved");
});

it("reads Sent on a login card answered without saving it, after a reload", async () => {
  await render({ ...loginCard, status: "answered", answer: "", remembered: false });
  expect(container.textContent).toContain("Sent");
  await render({ ...loginCard, status: "answered", answer: "" });
  expect(container.textContent).toContain("Saved");
});

it("offers Save to Vault only on login cards", async () => {
  await render(secretCard);
  expect(container.querySelector('[role="switch"]')).toBeNull();
  await render({ kind: "ask", text: "Code", input: "secret", purpose: "otp", status: "pending" });
  expect(container.querySelector('[role="switch"]')).toBeNull();
  await render({
    ...secretCard,
    credential: { name: "deploy_key", origin: "", auth: { type: "command" } },
  } as AskBlock);
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).not.toContain("Save to Vault");
});

it("quotes an edited reply and marks a sent draft", async () => {
  const block: AskBlock = { kind: "ask", text: "Send it?", status: "answered", answer: "Tuesday" };
  await render(block);
  expect(container.querySelector('[data-testid="ask-answer"]')?.textContent).toBe("Tuesday");
  expect(container.textContent).not.toContain("Answered");

  await render({ ...block, answer: "approved" });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(container.textContent).toContain("Sent");
});

it("dims the options a typed answer did not match", async () => {
  await render({
    kind: "ask",
    text: "Which city?",
    status: "answered",
    answer: "Paris",
    actions: [
      { id: "berlin", label: "Berlin" },
      { id: "seoul", label: "Seoul" },
    ],
  });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(container.textContent).not.toContain("Paris");
  expect(container.querySelector("[aria-pressed]")).toBeNull();

  await render({
    kind: "ask",
    text: "Which city?",
    status: "answered",
    answer: "seoul",
    actions: [{ id: "seoul", label: "Seoul" }],
  });
  expect(container.querySelector('[data-testid="ask-answer"]')).toBeNull();
  expect(button("ASeoul")!.getAttribute("aria-pressed")).toBe("true");
});

it("undoes a settings change from chat while it still holds", async () => {
  await render({
    kind: "ask",
    text: "Settings updated",
    status: "answered",
    settingsUpdate: {
      botId: "bot-1",
      before: { modelProvider: null, modelId: null, thinkingLevel: null },
      after: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
    },
  });
  expect(container.textContent).toContain("Settings updated");
  await act(async () => button("Undo")?.click());
  expect(rpc.bots.update).toHaveBeenCalledWith({
    botId: "bot-1",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    expectedSettings: {
      modelProvider: "google",
      modelId: "gemini-3.8-flash",
      thinkingLevel: "high",
    },
  });
  expect(button("Restored")?.disabled).toBe(true);
});
