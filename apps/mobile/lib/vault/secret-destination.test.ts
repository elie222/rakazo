import { describe, expect, it } from "vitest";
import { secretDestinationLabel } from "./secret-destination";

describe("mobile credential destination label", () => {
  it("omits the destination for a command credential", () => {
    const label = secretDestinationLabel({
      origin: "",
      auth: { type: "command" },
    });
    expect(label).toBe("");
  });

  it("shows the site origin for non-login credential types", () => {
    expect(
      secretDestinationLabel({
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      }),
    ).toBe("https://api.example.test");
  });

  it("shows a login's host in the punycode form it was saved in", () => {
    expect(
      secretDestinationLabel({
        origin: "https://xn--bcher-kva.example.test",
        auth: { type: "login" },
      }),
    ).toBe("xn--bcher-kva.example.test");
  });
});

it.each([
  ["https://billing.example.com", "billing.example.com"],
  ["https://example.com:8443", "example.com:8443"],
  ["https://example.com:443", "example.com"],
  ["invalid origin", "invalid origin"],
])("formats login destination %s as %s", (origin, expected) => {
  expect(secretDestinationLabel({ origin, auth: { type: "login" } })).toBe(expected);
});
