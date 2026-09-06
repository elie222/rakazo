import { describe, expect, it } from "vitest";
import { explicitSignInRoute, initialAuthMode } from "./auth-routing.js";

describe("mobile authentication routing", () => {
  it("defaults ordinary logged-out visitors to sign-up", () => {
    expect(initialAuthMode()).toBe("up");
  });

  it("honors the explicit sign-in route used after logout", () => {
    expect(explicitSignInRoute).toEqual({ pathname: "/sign-in", params: { mode: "in" } });
    expect(initialAuthMode(explicitSignInRoute.params.mode)).toBe("in");
  });
});
