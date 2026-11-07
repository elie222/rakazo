import { describe, expect, it, vi } from "vitest";

import {
  appendComposerDraftText,
  beginComposerDraftSubmission,
  clearComposerDrafts,
  composerDraftBindingsKey,
  composerDraftStorageKey,
  hasUnsentComposerDraft,
  readComposerDraft,
  readComposerDraftBindings,
  readComposerDraftSkill,
  settleComposerDraftSubmission,
  writeComposerDraft,
} from "./composer-draft.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("composer drafts", () => {
  it.each(["context", "same-text write", "submission"])(
    "fences old-document acceptance after a new document's %s on plain HTTP",
    async (change) => {
      const storage = memoryStorage();
      const crypto = globalThis.crypto;
      vi.stubGlobal("localStorage", storage);
      vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
      try {
        vi.resetModules();
        const first = await import("./composer-draft.js");
        first.writeComposerDraft("thread", "words");
        const submitted = first.beginComposerDraftSubmission("thread", "words");
        vi.resetModules();
        const second = await import("./composer-draft.js");
        if (change === "context") second.touchComposerDraftContext("thread");
        else if (change === "submission") second.beginComposerDraftSubmission("thread", "words");
        else second.writeComposerDraft("thread", "words");
        first.touchComposerDraftContext("thread");
        first.settleComposerDraftSubmission("thread", submitted, true);
        expect(second.readComposerDraft("thread")).toBe("words");
        const own = second.beginComposerDraftSubmission("thread", "words");
        second.touchComposerDraftContext("thread");
        second.settleComposerDraftSubmission("thread", own, true);
        expect(second.readComposerDraft("thread")).toBe("");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it("scopes stored drafts per thread", () => {
    expect(composerDraftStorageKey("bot:1")).toBe("rakazo.composerDraft.bot:1");
    expect(composerDraftStorageKey("group:2")).toBe("rakazo.composerDraft.group:2");
  });

  it("round-trips a draft and clears the key when empty", () => {
    const storage = memoryStorage();
    expect(readComposerDraft("bot:1", storage)).toBe("");
    writeComposerDraft("bot:1", "hello @ada", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("hello @ada");
    expect(readComposerDraft("group:2", storage)).toBe("");
    writeComposerDraft("bot:1", "", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("");
  });

  it("tolerates missing storage", () => {
    expect(readComposerDraft("bot:1", null)).toBe("");
    expect(() => writeComposerDraft("bot:1", "hi", null)).not.toThrow();
  });
  it("keeps raw text and restores exact, versioned occurrence bindings", () => {
    const storage = memoryStorage();
    const bindings = [
      { start: 0, end: 4, mention: { kind: "bot" as const, id: "bot-bob", name: "Bob" } },
      { start: 9, end: 13, mention: { kind: "group" as const, id: "group-bob", name: "Bob" } },
    ];
    writeComposerDraft("thread", "@Bob and @Bob", storage, bindings);
    expect(storage.getItem(composerDraftStorageKey("thread"))).toBe("@Bob and @Bob");
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "@Bob and @Bob", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "new text", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
  });

  it("keeps a skill chip with its draft text, and only while that text is unchanged", () => {
    const storage = memoryStorage();
    const skill = {
      id: "s1",
      name: "summarize",
      description: "",
      source: "user" as const,
      readOnly: false,
    };
    writeComposerDraft("thread", " the notes", storage, [], skill);
    expect(readComposerDraftSkill("thread", storage)).toEqual(skill);
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    writeComposerDraft("thread", " the notes", storage, []);
    expect(readComposerDraftSkill("thread", storage)).toBeNull();
    writeComposerDraft("thread", " the notes", storage, [], skill);
    writeComposerDraft("thread", "new text", storage);
    expect(readComposerDraftSkill("thread", storage)).toBeNull();
  });

  it("does not carry metadata from different saved text into a submission", () => {
    const storage = memoryStorage();
    const skill = {
      id: "s1",
      name: "summarize",
      description: "",
      source: "user" as const,
      readOnly: false,
    };
    vi.stubGlobal("localStorage", storage);
    try {
      writeComposerDraft("thread", "old body", storage, [], skill);
      const submitted = beginComposerDraftSubmission("thread", "new body");
      expect(readComposerDraftSkill("thread", storage)).toBeNull();
      settleComposerDraftSubmission("thread", submitted, true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a chip-only draft through failed submission and clears it on acceptance", () => {
    const storage = memoryStorage();
    const skill = {
      id: "s1",
      name: "summarize",
      description: "",
      source: "user" as const,
      readOnly: false,
    };
    vi.stubGlobal("localStorage", storage);
    try {
      writeComposerDraft("thread", "", storage, [], skill);
      expect(readComposerDraftSkill("thread", storage)).toEqual(skill);
      const failed = beginComposerDraftSubmission("thread", "");
      expect(readComposerDraftSkill("thread", storage)).toEqual(skill);
      settleComposerDraftSubmission("thread", failed, false);
      expect(readComposerDraftSkill("thread", storage)).toEqual(skill);
      expect(hasUnsentComposerDraft(storage)).toBe(true);
      const accepted = beginComposerDraftSubmission("thread", "");
      settleComposerDraftSubmission("thread", accepted, true);
      expect(readComposerDraftSkill("thread", storage)).toBeNull();
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
      expect(hasUnsentComposerDraft(storage)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves only late dictation after a chip-only send accepts", () => {
    const storage = memoryStorage();
    const skill = {
      id: "s1",
      name: "summarize",
      description: "",
      source: "user" as const,
      readOnly: false,
    };
    vi.stubGlobal("localStorage", storage);
    try {
      writeComposerDraft("thread", "", storage, [], skill);
      const submitted = beginComposerDraftSubmission("thread", "");
      appendComposerDraftText("thread", "late words");
      expect(readComposerDraftSkill("thread", storage)).toEqual(skill);
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("late words");
      expect(readComposerDraftSkill("thread", storage)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts chip-only drafts as unsent and clears them on signout", () => {
    const storage = memoryStorage();
    const skill = {
      id: "s1",
      name: "summarize",
      description: "",
      source: "user" as const,
      readOnly: false,
    };
    vi.stubGlobal("localStorage", storage);
    try {
      writeComposerDraft("thread", "", storage, [], skill);
      expect(hasUnsentComposerDraft(storage)).toBe(true);
      clearComposerDrafts();
      expect(hasUnsentComposerDraft(storage)).toBe(false);
      expect(readComposerDraftSkill("thread", storage)).toBeNull();
      expect(storage.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves legacy raw drafts and discards stale or unsupported metadata only", () => {
    const storage = memoryStorage({ [composerDraftStorageKey("thread")]: "@Bob" });
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    for (const record of [
      { version: 1, text: "different", bindings: [] },
      { version: 2, text: "@Bob", bindings: [] },
    ]) {
      storage.setItem(composerDraftBindingsKey("thread"), JSON.stringify(record));
      expect(readComposerDraftBindings("thread", storage)).toEqual([]);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    }
    storage.setItem(composerDraftBindingsKey("thread"), "broken json");
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    expect(readComposerDraft("thread", storage)).toBe("@Bob");
  });

  it("does not clear a newer same-text binding written by another tab when a send accepts", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const group = [
        { start: 0, end: 4, mention: { kind: "group" as const, id: "group", name: "Bob" } },
      ];
      const bot = [{ start: 0, end: 4, mention: { kind: "bot" as const, id: "bot", name: "Bob" } }];
      writeComposerDraft("thread", "@Bob", storage, group);
      const submitted = beginComposerDraftSubmission("thread", "@Bob");
      storage.setItem(
        composerDraftBindingsKey("thread"),
        JSON.stringify({ version: 1, text: "@Bob", bindings: bot }),
      );
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(readComposerDraftBindings("thread", storage)).toEqual(bot);
      const accepted = beginComposerDraftSubmission("thread", "@Bob");
      settleComposerDraftSubmission("thread", accepted, true);
      expect(readComposerDraft("thread", storage)).toBe("");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a newer same-text binding from another tab when late words join an in-flight send", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const group = [
        { start: 0, end: 4, mention: { kind: "group" as const, id: "group", name: "Bob" } },
      ];
      const bot = [{ start: 0, end: 4, mention: { kind: "bot" as const, id: "bot", name: "Bob" } }];
      writeComposerDraft("thread", "@Bob", storage, group);
      const submitted = beginComposerDraftSubmission("thread", "@Bob");
      // Another tab binds the same text to another mention while the send is in flight.
      storage.setItem(
        composerDraftBindingsKey("thread"),
        JSON.stringify({ version: 1, text: "@Bob", bindings: bot }),
      );
      appendComposerDraftText("thread", "new words");
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("@Bob new words");
      expect(readComposerDraftBindings("thread", storage)).toEqual(bot);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
