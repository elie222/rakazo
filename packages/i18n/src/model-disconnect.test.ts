import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { modelDisconnectWarning } from "./model-disconnect.js";

const unused = { mainModel: false, backupModel: false, usedBy: [] };

describe("modelDisconnectWarning", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  it("says nothing for a connection that serves nothing, or a preview that could not be read", () => {
    expect(modelDisconnectWarning(unused)).toBe("");
    expect(modelDisconnectWarning(null)).toBe("");
  });

  it("says the main model choice is cleared, ahead of a backup it also serves", () => {
    expect(modelDisconnectWarning({ ...unused, mainModel: true, backupModel: true })).toBe(
      "Your main model choice is cleared, and connecting again does not bring it back.",
    );
  });

  it("says a backup choice is cleared when that is all it serves", () => {
    expect(modelDisconnectWarning({ ...unused, backupModel: true })).toBe(
      "A backup model choice is cleared, and connecting again does not bring it back.",
    );
  });

  it("names the bots and routines that stop", () => {
    expect(modelDisconnectWarning({ ...unused, usedBy: ["Inbox", "Morning digest"] })).toBe(
      "Until it is connected again, runs stop for: Inbox, Morning digest.",
    );
  });

  it("names the first three and counts the rest", () => {
    expect(
      modelDisconnectWarning({ ...unused, mainModel: true, usedBy: ["A", "B", "C", "D", "E"] }),
    ).toBe(
      "Your main model choice is cleared, and connecting again does not bring it back. Until it is connected again, runs stop for: A, B, C and 2 more.",
    );
  });
});
