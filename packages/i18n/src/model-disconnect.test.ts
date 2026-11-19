import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { modelDisconnectWarning } from "./model-disconnect.js";

const unused = { mainModel: false, otherChoice: false, usedBy: [], usedByTotal: 0 };

describe("modelDisconnectWarning", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  it("says nothing for a connection that serves nothing, or a preview that could not be read", () => {
    expect(modelDisconnectWarning(unused)).toBe("");
    expect(modelDisconnectWarning(null)).toBe("");
  });

  it("says the main model choice is cleared, ahead of another choice it also serves", () => {
    expect(modelDisconnectWarning({ ...unused, mainModel: true, otherChoice: true })).toBe(
      "Your main model choice is cleared, and connecting again does not bring it back.",
    );
  });

  it("says a choice is cleared when a backup or another purpose is all it serves", () => {
    expect(modelDisconnectWarning({ ...unused, otherChoice: true })).toBe(
      "A model choice that uses it is cleared, and connecting again does not bring it back.",
    );
  });

  it("names the bots and routines that may stop", () => {
    expect(
      modelDisconnectWarning({ ...unused, usedBy: ["Inbox", "Morning digest"], usedByTotal: 2 }),
    ).toBe("These use it and may stop until it is connected again: Inbox, Morning digest.");
  });

  it("names the first three and counts the rest from the total, not from the names sent", () => {
    expect(
      modelDisconnectWarning({
        ...unused,
        mainModel: true,
        usedBy: ["A", "B", "C", "D", "E"],
        usedByTotal: 80,
      }),
    ).toBe(
      "Your main model choice is cleared, and connecting again does not bring it back. These use it and may stop until it is connected again: A, B, C and 77 more.",
    );
  });
});
