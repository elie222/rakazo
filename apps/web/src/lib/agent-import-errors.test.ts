import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it } from "vitest";
import { agentImportErrorText } from "./agent-import-errors";

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("an import the server refused", () => {
  it("is shown in the app's own words, by its reason", () => {
    const error = new ORPCError("CONFLICT", {
      message: "Instructions changed; review the current instructions first.",
      data: { reason: "instructions_changed" },
    });
    expect(agentImportErrorText(error)).toBe(
      "Its instructions changed. Review them, then try again.",
    );
    expect(
      agentImportErrorText(new ORPCError("BAD_REQUEST", { data: { reason: "model_needs_key" } })),
    ).toBe("Connect this model's provider first.");
  });

  it("leaves any other error to the usual handling", () => {
    expect(agentImportErrorText(new ORPCError("BAD_REQUEST", { message: "x" }))).toBeUndefined();
    expect(agentImportErrorText(new Error("offline"))).toBeUndefined();
  });
});
