import { describe, expect, it } from "vitest";
import { deploymentApps } from "./deployment-apps.js";

describe("bundled app configuration", () => {
  it("keeps absent credentials unconfigured", () => {
    expect(deploymentApps()[0]?.config).toBeNull();
  });
  it("never includes malformed secret configuration in errors", () => {
    expect(() => deploymentApps('{"drive":{"clientSecret":"fake-secret"}}')).toThrow(
      "Invalid DEPLOYMENT_APPS configuration",
    );
    expect(() => deploymentApps('{"other":{"clientId":"fake","clientSecret":"fake"}}')).toThrow(
      "Unknown deployment app",
    );
  });
});
