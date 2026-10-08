import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests, t } from "./i18n";
import { secretDestinationLabel } from "./secret-destination";

describe("mobile credential destination label", () => {
  afterEach(() => {
    resetI18nForTests("en");
  });

  it("shows the derived variable for a command credential, not the empty origin", () => {
    const label = secretDestinationLabel({
      name: "netbird-setup-key",
      origin: "",
      auth: { type: "command" },
    });
    expect(label).toBe(`${t("Command variable")} · $NETBIRD_SETUP_KEY`);
    expect(label).not.toBe("");
  });

  it("shows the site origin for every other credential type", () => {
    expect(
      secretDestinationLabel({
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      }),
    ).toBe("https://api.example.test");
  });

  it("localizes the command label for the active locale", () => {
    resetI18nForTests("zh-CN");
    const localized = t("Command variable");
    expect(localized).not.toBe("Command variable");
    const label = secretDestinationLabel({
      name: "api-token",
      origin: "",
      auth: { type: "command" },
    });
    expect(label).toBe(`${localized} · $API_TOKEN`);
    expect(label).not.toContain("Command variable");
  });
});
