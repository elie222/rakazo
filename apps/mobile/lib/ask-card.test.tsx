// @vitest-environment jsdom

import type { LoginFieldInput } from "@rakazo/contracts";
import type { CSSProperties, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMessage } from "./api";
import { messageRowLayout } from "./message-row-layout";
import { answerThreadMessage } from "./thread-answer";

type SheetProps = {
  destination: string;
  pending: boolean;
  onClose: () => void;
  loginFields: readonly string[] | undefined;
  onSave: (fields: LoginFieldInput[], remember: boolean) => Promise<void>;
};
let sheet: SheetProps;

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const flatten = (style: unknown): CSSProperties =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : ((style as CSSProperties) ?? {});
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement("div", { style: flatten(style) }, children),
    Text: ({
      children,
      numberOfLines,
      style,
    }: {
      children?: ReactNode;
      numberOfLines?: number;
      style?: { color?: string; fontWeight?: string; marginTop?: number };
    }) =>
      createElement(
        "span",
        {
          "data-lines": numberOfLines,
          "data-color": style?.color,
          "data-weight": style?.fontWeight,
          "data-spacing": style?.marginTop,
        },
        children,
      ),
    TextInput: ({
      accessibilityLabel,
      style,
      onChangeText,
    }: {
      accessibilityLabel?: string;
      style?: unknown;
      onChangeText: (value: string) => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        style: flatten(style),
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
  };
});

vi.mock("./native", () => ({
  useMobileTokens: () => ({ success: "success", mutedForeground: "muted" }),
}));

vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));

vi.mock("../components/native-action-button", async () => {
  const { createElement } = await import("react");
  return {
    NativeActionButton: ({
      label,
      onPress,
      disabled,
      prominence = "primary",
      fill,
      style,
    }: {
      label: string;
      onPress: () => void;
      disabled?: boolean;
      prominence?: string;
      fill?: boolean;
      style?: CSSProperties;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled,
          "data-prominence": prominence,
          "data-fill": fill,
          style,
        },
        label,
      ),
  };
});

vi.mock("../components/secret-ask-sheet", async () => {
  const { createElement } = await import("react");
  return {
    SecretAskSheet: (props: SheetProps) => {
      sheet = props;
      return createElement("div", { "data-sheet": true }, props.destination);
    },
  };
});

import { AskBlock } from "../components/thread/ask-block";

type AskBlockProps = Parameters<typeof AskBlock>[0];
type Ask = AskBlockProps["ask"];

const longTitle = "Sign in to the example account so I can finish the export you asked for";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render(
  ask: Record<string, unknown>,
  onAnswer: () => Promise<void> = async () => undefined,
  onDismiss: () => Promise<void> = async () => undefined,
) {
  await act(async () =>
    root.render(
      <AskBlock
        ask={{ kind: "ask", text: longTitle, status: "pending", ...ask } as Ask}
        canAnswer
        canDismiss
        onAnswer={onAnswer}
        onDismiss={onDismiss}
        actionProps={{}}
      />,
    ),
  );
  return container.querySelector("span")!;
}

it("caps a secret card's title at two lines and leaves question titles whole", async () => {
  const login = await render({
    input: "secret",
    purpose: "password",
    credential: {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    },
  });
  expect(login.textContent).toBe(longTitle);
  expect(login.dataset.lines).toBe("2");
  expect(container.textContent).toContain("login.example.test");
  expect(container.textContent).not.toContain("https://");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Continue");

  expect((await render({ input: "secret", purpose: "otp" })).dataset.lines).toBe("2");
  expect((await render({})).dataset.lines).toBeUndefined();
});

const loginAsk = {
  input: "secret",
  purpose: "password",
  credential: {
    name: "example_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  },
};

const loginAnswer = [
  { label: "Username", value: "example-user", hidden: false },
  { label: "Password", value: "example-password", hidden: true },
];

async function openSheet() {
  await act(async () => container.querySelector("button")!.click());
  expect(sheet.destination).toBe("login.example.test");
}

it("asks for a login card's fields and answers with them and an empty answer", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render({ ...loginAsk, loginFields: ["Email", "PIN"] }, onAnswer);
  await openSheet();
  expect(sheet.loginFields).toEqual(["Email", "PIN"]);

  await act(async () => sheet.onSave(loginAnswer, true));
  expect(onAnswer).toHaveBeenCalledWith("", loginAnswer);
  expect(container.textContent).toContain("Saved");
});

it("answers a login with Save to Vault off for this run only and reads Sent", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(loginAsk, onAnswer);
  await openSheet();

  await act(async () => sheet.onSave(loginAnswer, false));
  expect(onAnswer).toHaveBeenCalledWith("", loginAnswer, false);
  expect(state("Sent")?.dataset.color).toBe("success");
  expect(container.textContent).not.toContain("Saved");
});

it("leaves a login card without requested fields to the default labels", async () => {
  await render(loginAsk);
  await openSheet();
  expect(sheet.loginFields).toBeUndefined();
});

it("closes an open login sheet once the viewer is no longer the run's user", async () => {
  const renderAs = (canDismiss: boolean) =>
    act(async () =>
      root.render(
        <AskBlock
          ask={{ kind: "ask", text: longTitle, status: "pending", ...loginAsk } as Ask}
          canAnswer
          canDismiss={canDismiss}
          onAnswer={async () => undefined}
          onDismiss={async () => undefined}
          actionProps={{}}
        />,
      ),
    );
  await render(loginAsk);
  await openSheet();
  expect(sheet.pending).toBe(true);

  // The sheet clears its own fields before it closes, so it is told the card is no longer pending.
  await renderAs(false);
  expect(container.querySelector("[data-sheet]")).not.toBeNull();
  expect(sheet.pending).toBe(false);
  await act(async () => sheet.onClose());
  expect(container.querySelector("[data-sheet]")).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(0);

  await renderAs(true);
  expect(container.querySelector("[data-sheet]")).toBeNull();
});

it("keeps a reopened sheet open when an earlier save completes", async () => {
  let complete!: () => void;
  await render(
    loginAsk,
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await openSheet();
  const first = sheet;
  let saving!: Promise<void>;
  await act(async () => {
    saving = first.onSave(loginAnswer, true);
  });
  await act(async () => first.onClose());
  await openSheet();
  await act(async () => {
    complete();
    await saving;
  });
  // The earlier save does not close the reopened sheet itself; it tells it the card is answered,
  // so the sheet runs its own clearing steps before it closes.
  expect(container.querySelector("[data-sheet]")).not.toBeNull();
  expect(sheet.pending).toBe(false);
  expect(container.textContent).toContain("Saved");
  await act(async () => first.onClose());
  expect(container.querySelector("[data-sheet]")).not.toBeNull();
  await act(async () => sheet.onClose());
  expect(container.querySelector("[data-sheet]")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

it("closes the current sheet and keeps the card saved when refresh fails", async () => {
  const refresh = vi.fn().mockRejectedValue(new Error("offline"));
  const rpc = vi.fn().mockResolvedValue(undefined);
  await render(loginAsk, () =>
    answerThreadMessage(
      {
        botId: "bot-1",
        groupId: undefined,
        readOnly: false,
        rpc,
        isCurrentTarget: () => true,
        refresh,
        markRead: vi.fn(),
      },
      { id: "message-1", runId: "run-1" },
      "example-password",
    ),
  );
  await openSheet();
  await act(async () => sheet.onSave(loginAnswer, true));
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-sheet]")).toBeNull();
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).not.toContain("Could not send answer");
  expect(container.querySelector("button")).toBeNull();
});

function buttons() {
  return [...container.querySelectorAll("button")].map((item) => item.textContent);
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
}

it("dismisses an inline secret card without sending a value", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onDismiss = vi.fn(async () => undefined);
  await render({ input: "secret", purpose: "otp" }, onAnswer, onDismiss);
  expect(buttons()).toEqual(["Save", "Dismiss"]);
  expect(button("Save").dataset.prominence).toBe("primary");
  expect(button("Dismiss").dataset.prominence).toBe("secondary");

  await act(async () => button("Dismiss").click());

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Dismissed");
  expect(container.querySelector("input")).toBeNull();
  expect(buttons()).toEqual([]);
});

it("keeps the card open with a generic error when a dismissal fails", async () => {
  await render({ input: "secret", purpose: "otp" }, undefined, async () => {
    throw new Error("server detail");
  });

  await act(async () => button("Dismiss").click());

  expect(container.textContent).toContain("Could not send answer");
  expect(container.textContent).not.toContain("server detail");
  expect(container.textContent).not.toContain("Dismissed");
  expect(container.querySelector("input")).not.toBeNull();
});

function state(text: string) {
  return [...container.querySelectorAll("span")].find((item) => item.textContent === text);
}

it("shows a dismissed secret card as a muted Dismissed and a saved one as Saved", async () => {
  await render({ input: "secret", status: "answered", answer: "", dismissed: true });
  expect(state("Dismissed")?.dataset.color).toBe("muted");
  // A card's status line is medium, like every card status.
  expect(state("Dismissed")?.dataset.weight).toBe("500");
  expect(state("Dismissed")?.dataset.spacing).toBe("12");
  await render({ input: "secret", status: "answered", answer: "" });
  expect(state("Saved")?.dataset.color).toBe("success");
  expect(container.textContent).not.toContain("Dismissed");
  // A login used for this run only reads Sent, also once the card is reloaded.
  await render({ input: "secret", status: "answered", answer: "", remembered: false });
  expect(state("Sent")?.dataset.color).toBe("success");
});

it("offers Dismiss only on secret cards", async () => {
  await render({});
  expect(buttons()).toEqual(["Send answer"]);
});

it("dismisses a login card directly without opening the sheet", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const onDismiss = vi.fn(async () => undefined);
  await render(loginAsk, onAnswer, onDismiss);
  expect(buttons()).toEqual(["Continue", "Dismiss"]);
  expect(button("Continue").dataset.prominence).toBe("primary");
  expect(button("Dismiss").dataset.prominence).toBe("secondary");
  await act(async () => button("Dismiss").click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Dismissed");
  expect(container.querySelector("[data-sheet]")).toBeNull();
  expect(buttons()).toEqual([]);
});

it("lets the card's buttons wrap instead of overflowing at large text sizes", async () => {
  for (const ask of [{ input: "secret", purpose: "otp" }, loginAsk]) {
    await render(ask);
    const row = button("Dismiss").parentElement!;
    expect(row.style.flexDirection).toBe("row");
    expect(row.style.flexWrap).toBe("wrap");
  }
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
        <AskBlock
          ask={block}
          canAnswer
          canDismiss={canDismiss}
          onAnswer={async () => {}}
          onDismiss={async () => {}}
          actionProps={{}}
        />,
      ),
    );
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels.includes("Dismiss")).toBe(canDismiss);
    // A login is filled in only by the run's user; see the credential card test below.
    if (input === "login" && !canDismiss) return;
    const primary = button(input === "login" ? "Continue" : "Save");
    expect(primary.style.flex).toBe("1 1 0%");
    expect(primary.dataset.fill).toBe("true");
    if (canDismiss) expect(button("Dismiss").style.flex).toBe(primary.style.flex);
    expect(labels.includes(input === "login" ? "Continue" : "Save")).toBe(true);
  });
}

it("stretches secret inputs and equal actions, enabling Save only with input", async () => {
  await render({ input: "secret", purpose: "otp" });
  expect(container.firstElementChild?.getAttribute("style")).toContain("width: 100%");
  const input = container.querySelector("input")!;
  expect(input.style.alignSelf).toBe("stretch");
  expect(button("Save").disabled).toBe(true);
  for (const label of ["Save", "Dismiss"]) {
    expect(button(label).style.flex).toBe("1 1 0%");
    expect(button(label).dataset.fill).toBe("true");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "example-code",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Save").disabled).toBe(false);
  expect(button("Save").dataset.prominence).toBe("primary");
});

it("fills the message column only for secret asks, including answered and login asks", async () => {
  const isWideAskBlock = (blocks: unknown[]) =>
    messageRowLayout(blocks as MobileMessage["blocks"], { inGroup: false, columnWidth: 400 })
      .menuFullWidth;
  for (const status of ["pending", "answered"]) {
    for (const ask of [{ input: "secret" }, loginAsk]) {
      expect(isWideAskBlock([{ kind: "ask", ...ask, status }])).toBe(true);
      await render({ ...ask, status });
      expect((container.firstElementChild as HTMLElement).style.width).toBe("100%");
    }
  }
  expect(isWideAskBlock([{ kind: "ask" }])).toBe(false);
  expect(isWideAskBlock([{ kind: "ask", input: "secret", approvalEffectId: "approval" }])).toBe(
    false,
  );
  await render({});
  expect((container.firstElementChild as HTMLElement).style.width).toBe("90%");
});

it("uses the full column for wide asks and reserves only the visible avatar gutter", () => {
  const blocks = {
    wide: [{ kind: "ask", text: "Secret", input: "secret", status: "pending" }],
    regular: [{ kind: "text", text: "Hello" }],
    appConnect: [
      {
        kind: "app_connect",
        provider: "example",
        name: "Example",
        description: "",
        logo: null,
        status: "pending",
      },
    ],
    mcpApproval: [{ kind: "mcp_approval", serverId: "server-1", name: "Example" }],
  };
  const measure = (kind: keyof typeof blocks, avatar: boolean, inGroup: boolean) =>
    messageRowLayout(blocks[kind] as MobileMessage["blocks"], {
      activityBotId: avatar ? "bot-1" : undefined,
      inGroup,
      columnWidth: 400,
    });
  for (const [avatar, inGroup, gutter] of [
    [false, false, 0],
    [true, false, 36],
    [true, true, 28],
  ] as const) {
    const wide = measure("wide", avatar, inGroup);
    expect(wide.width).toBe("100%");
    expect(wide.maxWidth).toBe("100%");
    expect(wide.menuMaxWidth).toBe(400 - 40 - gutter);
    const regular = measure("regular", avatar, inGroup);
    expect(regular.width).toBeUndefined();
    expect(regular.maxWidth).toBe(avatar ? undefined : "90%");
    expect(regular.menuMaxWidth).toBe(avatar ? 360 - gutter : 324);
  }
  // Connect cards take the full bubble width rather than shrinking to their button.
  for (const kind of ["appConnect", "mcpApproval"] as const) {
    const card = measure(kind, false, false);
    expect(card.width).toBe("90%");
    expect(card.maxWidth).toBe("90%");
    expect(card.menuMaxWidth).toBe(324);
    expect(card.menuFullWidth).toBe(true);
  }
});

it.each([
  [
    "login",
    { name: "example_login", origin: "https://login.example.test", auth: { type: "login" } },
  ],
  ["API", { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } }],
])(
  "shows a %s credential card read-only to anyone but the run's user",
  async (_name, credential) => {
    const render = (canDismiss: boolean) =>
      act(async () =>
        root.render(
          <AskBlock
            ask={
              { kind: "ask", text: "Secret", input: "secret", status: "pending", credential } as Ask
            }
            canAnswer
            canDismiss={canDismiss}
            onAnswer={async () => {}}
            onDismiss={async () => {}}
            actionProps={{}}
          />,
        ),
      );

    await render(false);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("Secret");
    expect(container.textContent).not.toContain("Waiting for this bot’s response.");

    await render(true);
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
  },
);
