// @vitest-environment jsdom

import type { VoiceInfo } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { VoicePicker, voiceLanguageCodes } from "./VoicePicker";

const voices: VoiceInfo[] = [
  { id: "a", label: "Anna Bright", languages: ["de"] },
  { id: "b", label: "Brian Narrator", description: "Calm", languages: ["en"] },
  { id: "c", label: "Annabel", languages: ["en", "de"] },
  { id: "d", label: "Claire", languages: ["en"] },
  { id: "e", label: "Dieter", languages: ["de"] },
  { id: "f", label: "Unlabeled" },
];

describe("voiceLanguageCodes", () => {
  it("lists codes by how many voices speak them", () => {
    expect(voiceLanguageCodes(voices)).toEqual(["de", "en"]);
    expect(voiceLanguageCodes([{ id: "x", label: "X" }])).toEqual([]);
  });
});

describe("VoicePicker", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => undefined;
    onChange.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (list: VoiceInfo[] = voices, value = "a") =>
    act(() =>
      root.render(<VoicePicker id="voice" voices={list} value={value} onChange={onChange} />),
    );
  const open = () => act(() => container.querySelector<HTMLButtonElement>("button#voice")!.click());
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  const search = (text: string) =>
    act(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search voices"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const chip = (code: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("fieldset button")].find(
      (button) => button.textContent === code,
    )!;

  it("shows the chosen voice on the button", () => {
    render(voices, "b");
    expect(container.querySelector("button#voice")?.textContent).toBe("Brian Narrator (Calm)");
  });

  it("finds a part of a voice name, ignoring case", () => {
    render();
    open();
    expect(options()).toHaveLength(6);
    search("ANNA");
    expect(options()).toEqual(["Anna Bright", "Annabel"]);
    search("calm");
    expect(options()).toEqual(["Brian Narrator (Calm)"]);
    search("nothing");
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain("No matching voices");
  });

  it("keeps only voices of the chosen language, together with the text filter", () => {
    render();
    open();
    act(() => chip("de").click());
    expect(chip("de").getAttribute("aria-pressed")).toBe("true");
    expect(options()).toEqual(["Anna Bright", "Annabel", "Dieter"]);
    search("anna");
    expect(options()).toEqual(["Anna Bright", "Annabel"]);
    act(() => chip("en").click());
    expect(options()).toEqual(["Annabel"]);
    act(() => chip("en").click());
    expect(options()).toEqual(["Anna Bright", "Annabel"]);
  });

  it("picks a voice and closes with the filters cleared", () => {
    render();
    open();
    search("dieter");
    act(() => (document.querySelector('[role="option"]') as HTMLElement).click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("e");
    expect(options()).toEqual([]);
    open();
    expect(options()).toHaveLength(6);
  });

  it("offers no language chips when the provider names no languages", () => {
    render(voices.map(({ id, label }) => ({ id, label })));
    open();
    expect(document.querySelector("fieldset")).toBeNull();
    expect(options()).toHaveLength(6);
  });

  it("clears the language filter when it closes", () => {
    render();
    open();
    act(() => chip("de").click());
    expect(options()).toHaveLength(3);
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(options()).toEqual([]);
    open();
    expect(chip("de").getAttribute("aria-pressed")).toBe("false");
    expect(options()).toHaveLength(6);
  });

  it("offers the language chip even when only one code is named", () => {
    render([
      { id: "a", label: "Anna", languages: ["de"] },
      { id: "b", label: "Brian" },
    ]);
    open();
    act(() => chip("de").click());
    expect(options()).toEqual(["Anna"]);
  });

  it("shows a placeholder, never the raw id, when the saved voice is not in the list", () => {
    render(voices, "missing-voice-id");
    const trigger = container.querySelector<HTMLButtonElement>("button#voice")!;
    expect(trigger.textContent).toBe("Select a voice");
    expect(trigger.textContent).not.toContain("missing-voice-id");
  });
});
