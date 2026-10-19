import { i18n } from "@lingui/core";
import { normalizeRunError } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { translateRunError } from "./run-error";

afterEach(() => {
  i18n.activate("en");
});

it("uses the active Lingui catalog for shared run errors", () => {
  i18n.load("de", {
    "Your model provider": "Dein Modellanbieter",
    "{provider} is rate limiting requests. Try again shortly.":
      "{provider} drosselt Anfragen. Versuche es gleich noch einmal.",
  });
  i18n.activate("de");
  expect(
    normalizeRunError(
      '429: {"message":"API key rate limit exceeded"}',
      translateRunError,
      i18n.locale,
    ).summary,
  ).toBe("Dein Modellanbieter drosselt Anfragen. Versuche es gleich noch einmal.");
});
