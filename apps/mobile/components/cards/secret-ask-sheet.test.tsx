// @vitest-environment jsdom

import { BLOCKED_ITEM_ANSWER, UNCHOSEN_ITEM_ANSWER } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { CSSProperties, ReactNode, Ref } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => ({ show: undefined as (() => void) | undefined }));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
// Native commands sent to the fields, and each field's end-editing handler.
const native = vi.hoisted(() => ({
  commands: [] as string[],
  endEditing: {} as Record<string, (event: { nativeEvent: { text: string } }) => void>,
}));

vi.mock("react-native", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  const View = ({
    children,
    style = [],
    accessibilityViewIsModal,
  }: {
    children?: ReactNode;
    style?: CSSProperties[];
    accessibilityViewIsModal?: boolean;
  }) =>
    accessibilityViewIsModal ? (
      <div data-sheet style={Object.assign({}, ...style)}>
        {children}
      </div>
    ) : (
      <div>{children}</div>
    );
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
    Text: ({
      children,
      numberOfLines,
      accessibilityRole,
    }: {
      children?: ReactNode;
      numberOfLines?: number;
      accessibilityRole?: string;
    }) => (
      <span data-lines={numberOfLines} role={accessibilityRole}>
        {children}
      </span>
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
  useSafeAreaInsets: () => insets,
}));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label ?? accessibilityLabel}
    </button>
  ),
}));
vi.mock("../native/sheet-close-button", () => ({
  SheetCloseButton: ({ onPress }: { onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      Close
    </button>
  ),
}));

vi.mock("../native/native-switch", () => ({
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
import { resetI18nForTests } from "../../lib/i18n/i18n";
import { SecretAskSheet } from "./secret-ask-sheet";

const onClose = vi.fn();
const onSave = vi.fn<(fields: LoginFieldInput[], remember: boolean) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(insets, { left: 0, right: 0 });
  native.commands = [];
  native.endEditing = {};
  resetI18nForTests();
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

async function render(pending = true, loginFields?: string[], onDismiss?: () => Promise<void>) {
  await act(async () =>
    root.render(
      <SecretAskSheet
        title="Example sign-in"
        destination="https://login.example.test"
        loginFields={loginFields}
        pending={pending}
        onClose={onClose}
        onSave={onSave}
        onDismiss={onDismiss}
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

function buttonLabels() {
  return [...container.querySelectorAll("button")].map((item) => item.textContent);
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
  // Username and Password can't be wrong, so no switch asks.
  expect(hiddenSwitches()).toEqual([]);
});

it("shows the default labels translated but saves them in English", async () => {
  resetI18nForTests("de");
  onSave.mockResolvedValue();
  await render();
  expect(valueFields().map((input) => input.getAttribute("aria-label"))).toEqual([
    "Benutzername",
    "Passwort",
  ]);

  await type("Benutzername", "ada");
  await type("Passwort", "example-password");
  await act(async () => button("Speichern").click());

  expect(onSave.mock.lastCall![0].map((answer) => answer.label)).toEqual(["Username", "Password"]);
});

it.each([
  { left: 0, right: 72 },
  { left: 72, right: 0 },
])("keeps the sheet actions and fields inside the side insets (%j)", async ({ left, right }) => {
  Object.assign(insets, { left, right });
  await render();

  const sheet = container.querySelector<HTMLElement>("[data-sheet]")!;
  expect(sheet.style.paddingLeft).toBe(`${left}px`);
  expect(sheet.style.paddingRight).toBe(`${right}px`);
  expect(sheet.contains(button("Save"))).toBe(true);
  expect(sheet.contains(field("Password"))).toBe(true);
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

it("lets the person hide or show a field the bot named, and saves it as chosen", async () => {
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

it("shows the password while typing but still saves it as secret", async () => {
  onSave.mockResolvedValue();
  await render();

  await act(async () => button("Show Password").click());
  expect(field("Password").type).toBe("text");
  await act(async () => button("Hide Password").click());
  expect(field("Password").type).toBe("password");
  await act(async () => button("Show Password").click());

  await type("Username", "ada");
  await type("Password", "example-password");
  await act(async () => button("Save").click());

  expect(onSave).toHaveBeenCalledWith(
    [
      { label: "Username", value: "ada", hidden: false },
      { label: "Password", value: "example-password", hidden: true },
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

it("shows the full title and site before the login fields", async () => {
  await render();

  const texts = [...container.querySelectorAll("span")];
  const title = texts.find((item) => item.textContent === "Example sign-in")!;
  const site = texts.find((item) => item.textContent === "https://login.example.test")!;
  expect(title.dataset.lines).toBeUndefined();
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

  // A blank username counts as empty.
  await type("Username", "  ");
  expect(button("Save").disabled).toBe(true);
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
  expect(buttonLabels()).toEqual(["Close", "Continue", "Show Password"]);
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
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not send answer");
  expect(container.textContent).not.toContain("example-password");
});

it.each([
  [
    BLOCKED_ITEM_ANSWER,
    "This item is blocked for bots. Allow it in the Vault, or dismiss the request.",
  ],
  [
    UNCHOSEN_ITEM_ANSWER,
    "This bot can't use this item. Change it in the Vault, or dismiss the request.",
  ],
])("says why only when bots can't use the item it waited for (%s)", async (answer, shown) => {
  onSave.mockRejectedValue(new Error(answer));
  await render();
  await type("Username", "ada");
  await type("Password", "example-password");
  await act(async () => button("Save").click());
  expect(container.textContent).toContain(shown);
  expect(container.textContent).not.toContain("Could not send answer");
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

it("closes on Close a frame after the edited field reports it is empty", async () => {
  vi.useFakeTimers();
  const seen = recordFieldsOnClose();
  await render();
  await type("Username", "ada");
  await type("Password", "example-password");

  await act(async () => button("Close").click());

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

it("keeps Close and Save as the only sheet actions", async () => {
  await render();
  expect(buttonLabels()).toEqual(["Close", "Save", "Show Password"]);
});

it("offers Dismiss request under the fields only when the request can be turned down", async () => {
  const onDismiss = vi.fn(async () => undefined);
  await render(true, undefined, onDismiss);
  await type("Password", "example-password");
  await act(async () => button("Dismiss request").click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
  expect(field("Password").value).toBe("");
});

it("shows a generic error when dismissing fails", async () => {
  await render(true, undefined, async () => {
    throw new Error("server detail");
  });
  await act(async () => button("Dismiss request").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not send answer");
});

it("stays open while a dismissal is in flight, so its failure shows", async () => {
  const pending = deferred<void>();
  await render(true, undefined, () => pending.promise);
  await act(async () => button("Dismiss request").click());
  await act(async () => button("Close").click());
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => pending.reject(new Error("server detail")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not send answer");
});

it("masks a shown password again once a failed save clears it", async () => {
  onSave.mockRejectedValue(new Error("rejected"));
  await render();
  await act(async () => button("Show Password").click());
  await type("Username", "ada");
  await type("Password", "example-password");
  expect(field("Password").type).toBe("text");

  await act(async () => button("Save").click());

  expect(field("Password").value).toBe("");
  expect(field("Password").type).toBe("password");
  expect(buttonLabels()).toContain("Show Password");
});
