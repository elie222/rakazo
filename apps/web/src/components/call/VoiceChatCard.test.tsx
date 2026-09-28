// @vitest-environment jsdom

import type { VoiceChatGroup } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceChatCard } from "./VoiceChatCard";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const marker = {
  id: "marker-1",
  role: "bot",
  blocks: [{ kind: "voice_call" as const, title: "Booked a flight", farewell: "Talk soon" }],
};

const group: VoiceChatGroup = {
  kind: "voiceChat",
  key: "call:call-1",
  callId: "call-1",
  messages: [
    { id: "user-1", role: "user", blocks: [{ kind: "text", text: "book the flight" }] },
    { id: "bot-1", role: "bot", blocks: [{ kind: "text", text: "Booked." }] },
    marker,
  ],
  marker,
};

describe("VoiceChatCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function render(revealMessageId?: string) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<VoiceChatCard group={group} revealMessageId={revealMessageId} />);
    });
    return container;
  }

  it("stays collapsed until a jump targets a message inside it", () => {
    const collapsed = render();
    expect(collapsed.querySelector("[data-message-id]")).toBeNull();
    expect(collapsed.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");

    act(() => root?.unmount());
    container?.remove();
    const opened = render("user-1");
    expect(opened.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(opened.querySelector('[data-message-id="user-1"]')?.textContent).toBe("book the flight");
    expect(opened.querySelector('[data-message-id="bot-1"]')?.textContent).toBe("Booked.");
    expect(opened.querySelector('[data-message-id="marker-1"]')).not.toBeNull();

    act(() => {
      root?.render(<VoiceChatCard group={group} />);
    });
    expect(opened.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(opened.querySelector('[data-message-id="user-1"]')).not.toBeNull();
  });
});
