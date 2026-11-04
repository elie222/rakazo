import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraftScope } from "./composer-draft";
import { readComposerDraft, writeComposerDraft } from "./composer-draft";

vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test" }));

const files = vi.hoisted(() => new Map<string, string>());
/** Copy steps throw while `copy` is true; file creation is silent while `create` is, as on iOS. */
const failing = vi.hoisted(() => ({ copy: false, create: false }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return [...files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const path of [...files.keys()]) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
    list() {
      const names = new Set(
        [...files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
    // Like the device, a directory lands inside an existing destination.
    copySync(destination: Directory) {
      if (failing.copy) throw new Error("Copy failed");
      const target = destination.exists
        ? `${destination.uri}/${this.uri.split("/").pop()}`
        : destination.uri;
      for (const path of [...files.keys()])
        if (path.startsWith(`${this.uri}/`))
          files.set(target + path.slice(this.uri.length), files.get(path)!);
    }
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    textSync() {
      return files.get(this.uri);
    }
    override create(options?: { overwrite?: boolean }) {
      if (this.exists && !options?.overwrite) throw new Error("File exists");
      if (failing.create) return;
      files.set(this.uri, "");
    }
    override delete() {
      files.delete(this.uri);
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    moveSync(destination: File, options?: { overwrite?: boolean }) {
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      files.set(destination.uri, files.get(this.uri)!);
      files.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { cache: "cache", document: "document" } };
});

const scope: ComposerDraftScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  threadKey: "bot:bot-1",
};
function draftPath(root: string) {
  return `${root}/composer-drafts-v1/${encodeURIComponent(scope.apiBase)}/user-${encodeURIComponent(scope.userId)}/${encodeURIComponent(scope.threadKey)}.json`;
}
function legacyDraft(body: string) {
  files.set(draftPath("cache"), JSON.stringify({ version: 1, text: body, bindings: [] }));
}

beforeEach(() => {
  files.clear();
  failing.copy = false;
  failing.create = false;
});

it("keeps drafts in documents, not the cache", () => {
  expect(writeComposerDraft(scope, "Draft text", [])).toBe(true);
  expect(files.has(draftPath("document"))).toBe(true);
  expect(files.has(draftPath("cache"))).toBe(false);
  expect(readComposerDraft(scope)).toEqual({ text: "Draft text", bindings: [] });
});

it("moves a draft left in the cache into documents before reading it", () => {
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Legacy draft");
  expect(files.has(draftPath("document"))).toBe(true);
  expect(files.has(draftPath("cache"))).toBe(false);
});

it("does not copy a migrated cache draft over a newer saved one", () => {
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Legacy draft");
  expect(writeComposerDraft(scope, "Newer draft", [])).toBe(true);
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Newer draft");
});

it("does not let a cache draft reappear over drafts from a clean first launch", () => {
  expect(writeComposerDraft(scope, "First draft", [])).toBe(true);
  // A downgrade wrote to the cache again; its copy must not replace the newer draft.
  legacyDraft("Downgrade draft");
  expect(readComposerDraft(scope).text).toBe("First draft");
  expect(files.has(draftPath("document"))).toBe(true);
});

it("reads the draft from the cache while the copy to documents fails", () => {
  legacyDraft("Unsent draft");
  failing.copy = true;
  expect(readComposerDraft(scope).text).toBe("Unsent draft");
  failing.copy = false;
  // The composer's automatic save of what it read cannot erase the draft.
  expect(writeComposerDraft(scope, "Unsent draft", [])).toBe(true);
  expect(readComposerDraft(scope).text).toBe("Unsent draft");
});
it("does not save drafts when the clean-launch marker cannot be verified", () => {
  failing.create = true;
  expect(writeComposerDraft(scope, "First draft", [])).toBe(false);
  expect(files.has(draftPath("document"))).toBe(false);
  expect(readComposerDraft(scope).text).toBe("");
});
