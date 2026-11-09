// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerVoiceInputDeps, ComposerVoiceInputHandlers } from "./composer-voice-input";
import { COMPOSER_VOICE_HOLD_MS, useComposerVoiceInput } from "./composer-voice-input";

vi.mock("./dictation", () => ({
  available: vi.fn(),
  listen: vi.fn(),
  finish: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  deviceLanguage: async () => "en-US",
  getActiveUiLocale: () => "en-US",
}));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));

function fakeDeps() {
  let handlers: ComposerVoiceInputHandlers | null = null;
  let lastHeard = "";
  const deps: ComposerVoiceInputDeps = {
    dictate: vi.fn(async (next: ComposerVoiceInputHandlers) => {
      handlers = next;
      return true;
    }),
    finishDictation: vi.fn(() => {
      handlers?.onFinal(lastHeard);
    }),
    stopDictation: vi.fn(),
  };
  return {
    deps,
    hear: (text: string) => {
      lastHeard = text;
      handlers?.onInterim(text);
    },
    finishHeard: (text: string) => handlers?.onFinal(text),
    giveUp: (reason: "idle" | "failed") => handlers?.onGiveUp(reason),
  };
}

describe("mobile composer voice input", () => {
  let root: Root;
  let latest: ReturnType<typeof useComposerVoiceInput>;
  let filled: string[];
  let sent: string[];
  let notReady = 0;

  function render(deps: ComposerVoiceInputDeps) {
    function Harness() {
      latest = useComposerVoiceInput(deps, {
        onFill: (text) => {
          filled.push(text);
        },
        onSend: (text) => {
          sent.push(text);
        },
        onNotReady: () => {
          notReady += 1;
        },
      });
      return null;
    }
    act(() => root.render(createElement(Harness)));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    filled = [];
    sent = [];
    notReady = 0;
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fills the draft when a tap's turn ends on the quiet gap", async () => {
    const fake = fakeDeps();
    render(fake.deps);
    await act(async () => {
      await latest.pressIn();
    });
    expect(latest.listening).toBe(true);

    act(() => {
      fake.hear("你好");
    });
    expect(filled).toEqual(["你好"]);
    act(() => {
      fake.finishHeard("你好");
    });
    expect(filled).toEqual(["你好", "你好"]);
    expect(sent).toEqual([]);
    expect(latest.listening).toBe(false);
  });

  it("sends the turn when the press is held and released", async () => {
    const fake = fakeDeps();
    render(fake.deps);
    await act(async () => {
      await latest.pressIn();
    });
    act(() => {
      fake.hear("帮我订票");
    });
    act(() => {
      vi.advanceTimersByTime(COMPOSER_VOICE_HOLD_MS);
    });
    act(() => {
      latest.pressOut();
    });
    expect(fake.deps.finishDictation).toHaveBeenCalledOnce();
    expect(sent).toEqual(["帮我订票"]);
    expect(filled).toEqual(["帮我订票"]);
  });

  it("sends when the quiet gap ends a turn that is still being held", async () => {
    const fake = fakeDeps();
    render(fake.deps);
    await act(async () => {
      await latest.pressIn();
    });
    act(() => {
      vi.advanceTimersByTime(COMPOSER_VOICE_HOLD_MS);
    });
    act(() => {
      fake.finishHeard("在吗");
    });
    expect(sent).toEqual(["在吗"]);
  });

  it("says plainly when speech recognition is unavailable", async () => {
    const fake = fakeDeps();
    vi.mocked(fake.deps.dictate).mockResolvedValueOnce(false);
    render(fake.deps);
    await act(async () => {
      await latest.pressIn();
    });
    expect(notReady).toBe(1);
    expect(latest.listening).toBe(false);
    expect(sent).toEqual([]);
  });

  it("cancels dictation on a tap while listening", async () => {
    const fake = fakeDeps();
    render(fake.deps);
    await act(async () => {
      await latest.pressIn();
    });
    await act(async () => {
      await latest.pressIn();
    });
    expect(fake.deps.stopDictation).toHaveBeenCalled();
    expect(latest.listening).toBe(false);
    act(() => {
      fake.finishHeard("too late");
    });
    expect(filled).toEqual([]);
    expect(sent).toEqual([]);
  });
});
