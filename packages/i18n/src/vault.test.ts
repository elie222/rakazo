import { i18n } from "@lingui/core";
import { afterEach, expect, it } from "vitest";
import {
  secretAnswerErrorText,
  vaultBotsNote,
  vaultImportProblemLines,
  vaultImportText,
  vaultPolicyLabels,
  vaultSaveNotice,
} from "./vault";

// The server's fixed refusals, as the contracts send them.
const BLOCKED = "This item is blocked for bots. Allow it in the Vault, or dismiss the request.";
const UNCHOSEN = "This bot can't use this item. Change it in the Vault, or dismiss the request.";

afterEach(() => {
  i18n.activate("en");
});

it("says why a secret answer was refused, and nothing an error could echo", () => {
  i18n.activate("en");
  expect(secretAnswerErrorText(new Error(BLOCKED), "Could not send answer")).toBe(BLOCKED);
  expect(secretAnswerErrorText(new Error(UNCHOSEN), "Could not send answer")).toBe(UNCHOSEN);
  expect(
    secretAnswerErrorText(new Error("Rejected saved-password-1"), "Could not send answer"),
  ).toBe("Could not send answer");
});

it("says what an older server dropped from a save, in one place for both apps", () => {
  i18n.activate("en");
  expect(vaultSaveNotice({ policy: "off", alsoOn: ["https://www.example.test"] }, {})).toBe(
    "Saved, but this server can't block bots yet. Saved, but this server fills logins only on their own site.",
  );
  expect(vaultSaveNotice({ allBots: false }, { allBots: false })).toBe("");
});

it("names each policy the same in both apps", () => {
  i18n.activate("en");
  expect(vaultPolicyLabels()).toEqual({ allow: "Allow", ask: "Ask first", off: "Block" });
});

it.each([
  [true, true, "This Space keeps its own vault, so its bots can't use account items."],
  [true, false, "This Space keeps its own vault, so its bots can't use account items."],
  [false, true, "This limits only this Space's bots. Your other Spaces choose for their own."],
  [false, false, undefined],
])(
  "says under the bots, with its own vault %s and other Spaces %s: %s",
  (ownVault, otherSpaces, note) => {
    i18n.activate("en");
    expect(vaultBotsNote({ ownVault, otherSpaces })).toBe(note);
  },
);

it("names import results and unusable files", () => {
  i18n.activate("en");
  const text = vaultImportText();
  expect(text.labels).toEqual({
    added: "Added",
    toAdd: "To add",
    duplicate: "Already saved",
    repeat: "Repeated in the file",
    notHttps: "Not on an HTTPS site",
    noPassword: "No password",
    full: "Vault full",
    notSaved: "Not saved",
  });
  expect(text.reasons).toEqual({
    notHttps: "Not on an HTTPS site",
    noPassword: "No password",
    duplicate: "Already saved",
    repeat: "Repeated in the file",
    invalid: "Not saved",
    limit: "Vault full",
  });
  expect(text.fileProblems).toEqual({
    too_large: "This file is too large to import.",
    unreadable: "This file can't be read as CSV.",
    no_logins: "No website and password columns found.",
  });
});

it("lists an import's left-out rows the same way in both apps", () => {
  i18n.activate("en");
  const rows = Array.from({ length: 7 }, (_, index) => ({
    line: index + 2,
    label: index === 0 ? "" : `site-${index}.example.test`,
    reason: index % 2 ? ("duplicate" as const) : ("noPassword" as const),
  }));
  expect(vaultImportProblemLines(rows)).toEqual([
    "Row 2 · No password",
    "Row 3 · site-1.example.test · Already saved",
    "Row 4 · site-2.example.test · No password",
    "Row 5 · site-3.example.test · Already saved",
    "Row 6 · site-4.example.test · No password",
    "And 2 more",
  ]);
  expect(vaultImportProblemLines(rows.slice(0, 1))).toEqual(["Row 2 · No password"]);
  expect(vaultImportProblemLines([])).toEqual([]);
});

it("uses the active catalog", () => {
  i18n.load("de", {
    [BLOCKED]: "Dieser Eintrag ist für Bots gesperrt.",
    "Vault full": "Tresor voll",
    "Saved, but this server can't ask you first.": "Gespeichert, aber ohne Nachfrage.",
    "Row {line}": "Zeile {line}",
    "And {more} more": "Und {more} weitere",
  });
  i18n.activate("de");
  expect(secretAnswerErrorText(new Error(BLOCKED), "x")).toBe(
    "Dieser Eintrag ist für Bots gesperrt.",
  );
  expect(vaultImportText().labels.full).toBe("Tresor voll");
  expect(vaultSaveNotice({ policy: "ask" }, { policy: "allow" })).toBe(
    "Gespeichert, aber ohne Nachfrage.",
  );
  const row = { label: "Old", reason: "limit" as const };
  expect(
    vaultImportProblemLines(Array.from({ length: 6 }, (_, index) => ({ ...row, line: index + 1 }))),
  ).toEqual(
    [1, 2, 3, 4, 5].map((line) => `Zeile ${line} · Old · Tresor voll`).concat("Und 1 weitere"),
  );
});
