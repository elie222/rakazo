import { describe, expect, it } from "vitest";
import { OrganizationLoginOrigin } from "./organization-vault.js";

describe("organization login site", () => {
  it("keeps only the HTTPS origin", () => {
    expect(OrganizationLoginOrigin.parse("https://example.test/sign-in?next=home")).toBe(
      "https://example.test",
    );
  });

  it.each([
    "http://example.test",
    "blob:https://example.test/fake",
    "https://fake:fake@example.test",
  ])("rejects %s", (site) => {
    expect(OrganizationLoginOrigin.safeParse(site).success).toBe(false);
  });
});
