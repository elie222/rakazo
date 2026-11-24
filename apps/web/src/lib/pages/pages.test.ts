// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createPageSession } from "./pages";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

const card = {
  id: "m1",
  blocks: [{ kind: "page" as const, pageId: "p1", version: 1, title: "Plan" }],
};

describe("page session", () => {
  it.each([
    { top: 24, useOpener: true, position: "partly visible" },
    { top: 8, useOpener: false, position: "above the chat" },
    { top: 332, useOpener: false, position: "below the chat" },
  ])("restores focus with no scroll when the opener is $position", ({ top, useOpener }) => {
    const transcript = document.body.appendChild(document.createElement("section"));
    transcript.tabIndex = -1;
    const opener = transcript.appendChild(document.createElement("button"));
    const session = createPageSession({ current: transcript });
    vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 32, 600, 300));
    vi.spyOn(opener, "getBoundingClientRect").mockReturnValue(new DOMRect(20, top, 120, 24));
    try {
      opener.focus();
      const focusVisible = opener.matches(":focus-visible");
      session.rememberOpener();
      opener.blur();
      const target = useOpener ? opener : transcript;
      const focus = vi.spyOn(target, "focus");

      expect(session.restoreFocus()).toBe(false);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible });
      expect(document.activeElement).toBe(target);
    } finally {
      transcript.remove();
    }
  });

  it("returns focus to the side panel when its opener is gone and the chat is inert", () => {
    const shell = document.body.appendChild(document.createElement("div"));
    const chat = shell.appendChild(document.createElement("main"));
    chat.setAttribute("inert", "");
    const transcript = chat.appendChild(document.createElement("section"));
    transcript.tabIndex = -1;
    // jsdom does not enforce inert when focus is requested.
    vi.spyOn(transcript, "focus").mockImplementation(() => {});
    const panel = shell.appendChild(document.createElement("aside"));
    panel.tabIndex = -1;
    const opener = panel.appendChild(document.createElement("button"));
    const close = shell.appendChild(document.createElement("button"));
    const session = createPageSession({ current: transcript }, { current: panel });
    try {
      opener.focus();
      session.rememberOpener();
      opener.remove();
      close.focus();

      expect(session.restoreFocus()).toBe(false);
      expect(document.activeElement).toBe(panel);
    } finally {
      shell.remove();
    }
  });

  it("allows the dialog's default focus restoration if neither target can receive focus", () => {
    const transcript = document.body.appendChild(document.createElement("section"));
    const opener = transcript.appendChild(document.createElement("button"));
    const session = createPageSession({ current: transcript });
    try {
      opener.focus();
      session.rememberOpener();
      opener.disabled = true;
      opener.blur();

      expect(session.restoreFocus()).toBe(true);
    } finally {
      transcript.remove();
    }
  });

  it("replies to the open page's card unless the user picked a reply themselves", () => {
    const session = createPageSession();
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger", replyToMessageId: "m1" });
    expect(session.send("bigger", [card], "m0")).toEqual({ text: "bigger" });
    session.dock.set({ page: null });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger" });
  });

  it("opens Share only on the page it was asked with, once", () => {
    const session = createPageSession();
    session.askShare("A");
    expect(session.takeShare("B")).toBe(false);
    expect(session.takeShare("A")).toBe(false);
    session.askShare("A");
    expect(session.takeShare("A")).toBe(true);
    // Back to the same page in history does not ask again.
    expect(session.takeShare("A")).toBe(false);
  });
});

describe("page replies", () => {
  it("hands a page's reply to the composer collapsed, only while a page is open", () => {
    const session = createPageSession();
    const received: string[] = [];
    const stop = session.subscribeReply((text) => received.push(text));
    session.offerReply("closed page");
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    session.offerReply("  Watch   the\n shirt ");
    session.offerReply("   ");
    session.offerReply("x".repeat(301));
    session.offerReply({ text: "object" });
    session.offerReply("x".repeat(300));
    stop();
    session.offerReply("after unsubscribe");
    expect(received).toEqual(["Watch the shirt", "x".repeat(300)]);
  });
});
