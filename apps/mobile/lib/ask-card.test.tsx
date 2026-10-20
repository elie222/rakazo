// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { secretDestinationLabel } from "./secret-destination";

// Render the screen's actual ask card without importing its native dependencies.
// Keep Vitest's jsdom URL transform from replacing the file URL with self.location.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const cardSource = source.slice(
  source.indexOf("function AskBlock({"),
  source.indexOf("const askInputStyles = StyleSheet.create("),
);
type SheetProps = {
  destination: string;
  pending: boolean;
  onClose: () => void;
  onSave: (password: string, username: string) => Promise<void>;
};
let sheet: SheetProps;
const scope = {
  React,
  useState,
  useRef,
  useMobileTokens: () => ({}),
  useI18n: () => ({ t: (text: string) => text }),
  isSecretAskBlock: (block: { input?: string }) => block.input === "secret",
  plainAskTitle: (text: string) => text,
  secretDestinationLabel,
  secretFieldTraits: () => ({}),
  errorText: (_error: unknown, fallback: string) => fallback,
  askInputStyles: { field: {} },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) => (
    <span data-lines={numberOfLines}>{children}</span>
  ),
  TextInput: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
    <input aria-label={accessibilityLabel} />
  ),
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
  SecretAskSheet: (props: SheetProps) => {
    sheet = props;
    return <div data-sheet>{props.destination}</div>;
  },
};
const AskBlock = new Function(
  ...Object.keys(scope),
  ts.transpileModule(`${cardSource}\nreturn AskBlock;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(...Object.values(scope));

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
) {
  await act(async () =>
    root.render(
      <AskBlock
        ask={{ kind: "ask", text: longTitle, status: "pending", ...ask }}
        canAnswer
        onAnswer={onAnswer}
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

async function openSheet() {
  await act(async () => container.querySelector("button")!.click());
  expect(sheet.destination).toBe("login.example.test");
}

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
    saving = first.onSave("example-password", "example-user");
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
  const handler = source.slice(
    source.indexOf("  const answerMessage = useCallback("),
    source.indexOf("  const openBot = useCallback("),
  );
  const handlerScope = {
    useCallback: <T,>(callback: T) => callback,
    botId: "bot-1",
    groupId: undefined,
    readOnly: false,
    rpc,
    isCurrentTarget: () => true,
    refresh,
  };
  const answerMessage = new Function(
    ...Object.keys(handlerScope),
    ts.transpileModule(`${handler}\nreturn answerMessage;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(handlerScope));
  await render(loginAsk, () =>
    answerMessage({ id: "message-1", runId: "run-1" }, "example-password"),
  );
  await openSheet();
  await act(async () => sheet.onSave("example-password", "example-user"));
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-sheet]")).toBeNull();
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).not.toContain("Could not send answer");
  expect(container.querySelector("button")).toBeNull();
});
