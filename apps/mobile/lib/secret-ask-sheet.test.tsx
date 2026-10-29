// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => ({ show: undefined as (() => void) | undefined }));
// Native commands sent to the fields, and each field's end-editing handler.
const native = vi.hoisted(() => ({
  commands: [] as string[],
  endEditing: {} as Record<string, (event: { nativeEvent: { text: string } }) => void>,
}));

vi.mock("react-native", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Modal: ({
      children,
      presentationStyle,
      onShow,
    }: {
      children?: ReactNode;
      presentationStyle?: string;
      onShow?: () => void;
    }) => {
      modal.show = onShow;
      return <div data-presentation={presentationStyle}>{children}</div>;
    },
    Platform: { OS: "ios" },
    View,
    ScrollView: ({
      children,
      automaticallyAdjustKeyboardInsets,
    }: {
      children?: ReactNode;
      automaticallyAdjustKeyboardInsets?: boolean;
    }) => <div data-keyboard-insets={automaticallyAdjustKeyboardInsets}>{children}</div>,
    Text: ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) => (
      <span data-lines={numberOfLines}>{children}</span>
    ),
    TextInput: function TextInput({
      ref,
      value,
      onChangeText,
      onEndEditing,
      accessibilityLabel,
      secureTextEntry,
      textContentType,
      autoComplete,
      autoFocus,
      editable,
    }: {
      ref?: Ref<unknown>;
      value: string;
      onChangeText: (value: string) => void;
      onEndEditing?: (event: { nativeEvent: { text: string } }) => void;
      accessibilityLabel: string;
      secureTextEntry?: boolean;
      textContentType?: string;
      autoComplete?: string;
      autoFocus?: boolean;
      editable?: boolean;
    }) {
      const input = useRef<HTMLInputElement>(null);
      if (onEndEditing) native.endEditing[accessibilityLabel] = onEndEditing;
      useImperativeHandle(ref, () => ({
        focus: () => input.current?.focus(),
        clear: () => native.commands.push(`clear ${accessibilityLabel}`),
        blur: () => native.commands.push(`blur ${accessibilityLabel}`),
      }));
      return (
        <input
          ref={input}
          type={secureTextEntry ? "password" : "text"}
          value={value}
          onChange={(event) => onChangeText(event.target.value)}
          aria-label={accessibilityLabel}
          data-content-type={textContentType}
          data-autocomplete={autoComplete}
          readOnly={editable === false}
          // biome-ignore lint/a11y/noAutofocus: mirrors the native prop under test.
          autoFocus={autoFocus}
        />
      );
    },
    StyleSheet: { create: <T,>(styles: T) => styles },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ useThemedStyles: (factory: () => unknown) => factory() }));
const i18n = vi.hoisted(() => ({ t: (text: string) => text }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => i18n.t(text) }) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));

vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    value,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    accessibilityLabel: string;
  }) => (
    <input
      type="checkbox"
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
      aria-label={accessibilityLabel}
    />
  ),
}));

import type { LoginFieldInput } from "@rakazo/contracts";
import { SecretAskSheet } from "../components/secret-ask-sheet";

const onClose = vi.fn();
const onSave = vi.fn<(fields: LoginFieldInput[], remember: boolean) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  native.commands = [];
  native.endEditing = {};
  i18n.t = (text) => text;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(pending = true, loginFields?: string[]) {
  await act(async () =>
    root.render(
      <SecretAskSheet
        title="Example sign-in"
        destination="https://login.example.test"
        loginFields={loginFields}
        pending={pending}
        onClose={onClose}
        onSave={onSave}
      />,
    ),
  );
}

function field(label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  return input!;
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(match).toBeDefined();
  return match!;
}

async function type(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function hiddenSwitches() {
  return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Hidden"]')];
}

function valueFields() {
  return [...container.querySelectorAll<HTMLInputElement>("input:not([type=checkbox])")];
}

it("opens as a page sheet with the title, the default fields and the destination", async () => {
  await render();

  expect(container.querySelector("[data-presentation]")?.getAttribute("data-presentation")).toBe(
    "pageSheet",
  );
  expect(container.textContent).toContain("Example sign-in");
  expect(container.textContent).toContain("https://login.example.test");
  expect(valueFields().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Username",
    "Password",
  ]);
  // As logins always started: Username visible, Password hidden.
  expect(field("Username").type).toBe("text");
  const password = field("Password");
  expect(password.type).toBe("password");
  expect(password.dataset.contentType).toBe("password");
  expect(password.dataset.autocomplete).toBe("current-password");
  expect(hiddenSwitches().map((input) => input.checked)).toEqual([false, true]);
});

it("shows the default labels translated but saves them in English", async () => {
  const translated: Record<string, string> = { Username: "Benutzername", Password: "Passwort" };
  i18n.t = (text) => translated[text] ?? text;
  onSave.mockResolvedValue();
  await render();
  expect(valueFields().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Benutzername",
    "Passwort",
  ]);

  await type("Benutzername", "ada");
  await type("Passwort", "example-password");
  await act(async () => button("Save").click());

  expect(onSave.mock.lastCall![0].map((answer) => answer.label)).toEqual(["Username", "Password"]);
});

it("starts an ID and a phone visible and a PIN hidden", async () => {
  await render(true, ["ID number", "Phone number", "PIN"]);

  expect(valueFields().map((input) => [input.getAttribute("aria-label"), input.type])).toEqual([
    ["ID number", "text"],
    ["Phone number", "text"],
    ["PIN", "password"],
  ]);
  expect(hiddenSwitches().map((input) => input.checked)).toEqual([false, false, true]);
});

it("starts every field hidden when no label names an identifier", async () => {
  await render(true, ["Memorable word", "Card number"]);

  expect(valueFields().map((input) => input.type)).toEqual(["password", "password"]);
  expect(hiddenSwitches().map((input) => input.checked)).toEqual([true, true]);
});

it("lets the person hide or show a field, and saves it as chosen", async () => {
  onSave.mockResolvedValue();
  await render(true, ["Email", "PIN"]);

  expect(field("Email").type).toBe("text");
  expect(field("Email").dataset.contentType).toBe("none");
  expect(field("PIN").type).toBe("password");

  await act(async () => hiddenSwitches()[0]!.click());
  expect(field("Email").type).toBe("password");
  await act(async () => hiddenSwitches()[0]!.click());
  expect(field("Email").type).toBe("text");

  await type("Email", "ada@example.test");
  await type("PIN", "1234");
  await act(async () => button("Save").click());

  expect(onSave).toHaveBeenCalledWith(
    [
      { label: "Email", value: "ada@example.test", hidden: false },
      { label: "PIN", value: "1234", hidden: true },
    ],
    true,
  );
});

// A field focused while the page sheet is still being laid out clips its placeholder at the
// largest text sizes, so Username takes focus only once the sheet is up.
it("focuses Username once the sheet has been shown", async () => {
  await render();
  expect(document.activeElement).not.toBe(field("Username"));

  await act(async () => modal.show?.());

  expect(document.activeElement).toBe(field("Username"));
});

it("shows the site right under a title capped at two lines, before the fields", async () => {
  await render();

  const texts = [...container.querySelectorAll("span")];
  const title = texts.find((item) => item.textContent === "Example sign-in")!;
  const site = texts.find((item) => item.textContent === "https://login.example.test")!;
  expect(title.dataset.lines).toBe("2");
  expect(site.dataset.lines).toBeUndefined();
  expect(title.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    site.compareDocumentPosition(field("Username")) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("lets the fields scroll above the keyboard", async () => {
  await render();
  const scroll = container.querySelector("[data-keyboard-insets]");
  expect(scroll?.getAttribute("data-keyboard-insets")).toBe("true");
  expect(scroll?.contains(field("Username"))).toBe(true);
});

it("enables Save only once every field has a value", async () => {
  await render();
  expect(button("Save").disabled).toBe(true);

  await type("Password", "example-password");
  expect(button("Save").disabled).toBe(true);

  await type("Username", "ada");
  await type("Password", "");
  expect(button("Save").disabled).toBe(true);

  await type("Password", "example-password");
  expect(button("Save").disabled).toBe(false);

  // A blank value counts only while it is hidden.
  await type("Username", "  ");
  expect(button("Save").disabled).toBe(true);
  await act(async () => hiddenSwitches()[0]!.click());
  expect(button("Save").disabled).toBe(false);
});

it("saves the default fields under their English labels, then clears them", async () => {
  onSave.mockResolvedValue();
  await render();
  await type("Username", "ada@example.test");
  await type("Password", " example-password ");

  await act(async () => button("Save").click());

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith(
    [
      { label: "Username", value: "ada@example.test", hidden: false },
      { label: "Password", value: " example-password ", hidden: true },
    ],
    true,
  );
  expect(field("Username").value).toBe("");
  expect(field("Password").value).toBe("");
});

function saveToVault() {
  return container.querySelector<HTMLInputElement>('input[aria-label="Save to Vault"]')!;
}

it("starts with Save to Vault on, under the fields", async () => {
  await render();
  expect(saveToVault().checked).toBe(true);
  const inputs = [...container.querySelectorAll("input")];
  expect(inputs.indexOf(saveToVault())).toBe(inputs.length - 1);
});

it("sends a login for this run only once Save to Vault is off, behind Continue", async () => {
  onSave.mockResolvedValue();
  await render();
  await type("Username", "ada@example.test");
  await act(async () => saveToVault().click());
  expect(saveToVault().checked).toBe(false);
  // Turning it off keeps what was typed.
  expect(field("Username").value).toBe("ada@example.test");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Cancel",
    "Continue",
  ]);
  await type("Password", "example-password");
  await act(async () => button("Continue").click());

  expect(onSave).toHaveBeenCalledWith(
    [
      { label: "Username", value: "ada@example.test", hidden: false },
      { label: "Password", value: "example-password", hidden: true },
    ],
    false,
  );
  expect(field("Password").value).toBe("");
});

it("clears both fields and shows a generic error when saving fails", async () => {
  onSave.mockRejectedValue(new Error("server said example-password was rejected"));
  await render();
  await type("Username", "ada");
  await type("Password", "example-password");

  await act(async () => button("Save").click());

  expect(field("Username").value).toBe("");
  expect(field("Password").value).toBe("");
  expect(button("Save").disabled).toBe(true);
  expect(container.textContent).toContain("Could not send answer");
  expect(container.textContent).not.toContain("example-password");
});

// iOS offers to save the password when the sheet goes away while a field still holds text, so
// the sheet closes only once the field being edited has reported that it is empty.
function recordFieldsOnClose() {
  const seen: (string | boolean)[][] = [];
  onClose.mockImplementation(() => {
    const username = field("Username");
    const password = field("Password");
    seen.push([username.value, password.value, username.readOnly, password.readOnly]);
  });
  return seen;
}

async function endEditing(label: string, text: string) {
  await act(async () => native.endEditing[label]!({ nativeEvent: { text } }));
}

async function nextFrame() {
  await act(async () => vi.advanceTimersToNextFrame());
}

it("closes on Cancel a frame after the edited field reports it is empty", async () => {
  vi.useFakeTimers();
  const seen = recordFieldsOnClose();
  await render();
  await type("Username", "ada");
  await type("Password", "example-password");

  await act(async () => button("Cancel").click());

  expect(native.commands).toEqual([
    "clear Username",
    "clear Password",
    "blur Username",
    "blur Password",
  ]);
  expect(field("Username").readOnly).toBe(true);
  expect(field("Password").readOnly).toBe(true);

  // A field that still holds text when editing ends keeps the sheet open.
  await endEditing("Password", "example-password");
  await nextFrame();
  expect(onClose).not.toHaveBeenCalled();

  await endEditing("Password", "");
  expect(onClose).not.toHaveBeenCalled();
  await nextFrame();
  expect(seen).toEqual([["", "", true, true]]);

  // Later reports don't close it again.
  await endEditing("Username", "");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
});

it("ignores end-editing reports while the sheet stays open", async () => {
  vi.useFakeTimers();
  await render();
  await endEditing("Username", "");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(onClose).not.toHaveBeenCalled();
});

it("closes after a delay when no field reports, as when the card is no longer pending", async () => {
  vi.useFakeTimers();
  const seen = recordFieldsOnClose();
  await render();
  await type("Username", "ada");
  await type("Password", "example-password");

  await render(false);
  expect(native.commands).toEqual([
    "clear Username",
    "clear Password",
    "blur Username",
    "blur Password",
  ]);
  await act(async () => vi.advanceTimersByTime(499));
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => vi.advanceTimersByTime(1));
  await nextFrame();
  expect(seen).toEqual([["", "", true, true]]);
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps Cancel and Save as the only sheet actions", async () => {
  await render();
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Cancel",
    "Save",
  ]);
});
