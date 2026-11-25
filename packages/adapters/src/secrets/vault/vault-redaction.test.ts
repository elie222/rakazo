import type { BotSecretDestination } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  apiKeyRedactionForms,
  commandRedactionForms,
  passwordRedactionForms,
} from "./vault-redaction.js";

describe("vault redaction normalized forms", () => {
  it("adds trimmed, whitespace-collapsed, excerpt-normalized, and NFC variants for command, password, and API key values", () => {
    const nfd = "  cafe\u0301  token\r\n\r\n\r\nline2  ";
    const expectedExcerpt = "caf\u00e9 token\n\nline2";
    const expectedCollapsed = "caf\u00e9 token line2";

    const commandForms = commandRedactionForms(nfd);
    expect(commandForms).toContain(nfd);
    expect(commandForms).toContain(expectedExcerpt);
    expect(commandForms).toContain(expectedCollapsed);
    expect(commandForms).toContain(Buffer.from(expectedCollapsed).toString("base64"));

    const passwordForms = passwordRedactionForms(nfd);
    expect(passwordForms).toContain(
      new URLSearchParams({ v: expectedCollapsed }).toString().slice(2),
    );

    const bearerDestination: BotSecretDestination = {
      name: "api_key",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };
    const bearerForms = apiKeyRedactionForms(bearerDestination, "api   token   val");
    expect(bearerForms).toContain("api token val");
    expect(bearerForms).toContain(Buffer.from("api token val").toString("base64"));
    expect(bearerForms).toContain(encodeURIComponent("api token val"));

    const basicDestination: BotSecretDestination = {
      name: "basic_key",
      origin: "https://api.example.test",
      auth: { type: "basic", username: "svc" },
    };
    const basicForms = apiKeyRedactionForms(basicDestination, nfd);
    expect(basicForms).toContain(expectedExcerpt);
    expect(basicForms).toContain(expectedCollapsed);
    expect(basicForms).toContain(encodeURIComponent(expectedCollapsed));
  });

  it("drops normalized variants shorter than the minimum redaction length", () => {
    const forms = commandRedactionForms("  abc  ");
    expect(forms).toContain("  abc  ");
    expect(forms).not.toContain("abc");
  });
});
