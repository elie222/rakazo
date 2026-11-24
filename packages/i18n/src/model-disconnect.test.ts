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

  it("says the main model choice is cleared", () => {
    expect(modelDisconnectWarning({ ...unused, mainModel: true })).toBe(
      "Reconnecting will not restore the main model choice that uses this connection.",
    );
  });

  it("names both when it serves the main model and another choice", () => {
    expect(modelDisconnectWarning({ ...unused, mainModel: true, otherChoice: true })).toBe(
      "Reconnecting will not restore the main model choice or other choices that use this connection.",
    );
  });

  it("says a choice is cleared when a backup or another purpose is all it serves", () => {
    expect(modelDisconnectWarning({ ...unused, otherChoice: true })).toBe(
      "Reconnecting will not restore saved model choices that use this connection.",
    );
  });

  it("names the bots and routines that may stop", () => {
    expect(
      modelDisconnectWarning({ ...unused, usedBy: ["Inbox", "Morning digest"], usedByTotal: 2 }),
    ).toBe("Inbox, Morning digest may stop until you reconnect.");
  });

  it("warns without naming pins when another connection remains", () => {
    expect(modelDisconnectWarning({ ...unused, usedByTotal: 2 })).toBe(
      "Bots and routines that rely on this connection may stop.",
    );
  });

  it("counts the affected bots and routines beyond the names sent", () => {
    expect(
      modelDisconnectWarning({
        ...unused,
        mainModel: true,
        usedBy: ["A", "B", "C"],
        usedByTotal: 80,
      }),
    ).toBe(
      "Reconnecting will not restore the main model choice that uses this connection. A, B, C and 77 more may stop until you reconnect.",
    );
  });
});
