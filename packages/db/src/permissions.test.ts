import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { hasPermission, permissionsForRole, spaceRoleTokens } from "./permissions.js";

const owner: Actor = {
  userId: "user-owner",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
  role: "owner",
};

const member: Actor = {
  ...owner,
  userId: "user-member",
  email: "member@example.test",
  role: "member",
};

describe("spaceRoleTokens", () => {
  it("splits Better Auth comma-separated roles", () => {
    expect(spaceRoleTokens("admin, owner")).toEqual(["admin", "owner"]);
  });
});

describe("hasPermission defaults", () => {
  it("gives owners finance read and write", () => {
    expect(hasPermission(owner, "finance.read")).toBe(true);
    expect(hasPermission(owner, "finance.write")).toBe(true);
  });

  it("gives members finance read only", () => {
    expect(hasPermission(member, "finance.read")).toBe(true);
    expect(hasPermission(member, "finance.write")).toBe(false);
  });

  it("unions permissions across comma-separated role tokens", () => {
    const adminOwner: Actor = { ...owner, role: "admin, owner" };
    expect(hasPermission(adminOwner, "finance.write")).toBe(true);
  });
});

describe("hasPermission overrides", () => {
  it("uses space role permission rows when present for a role token", () => {
    expect(
      hasPermission(member, "finance.write", [
        { role: "member", permission: "finance.read" },
        { role: "member", permission: "finance.write" },
      ]),
    ).toBe(true);
    expect(
      hasPermission(owner, "finance.write", [{ role: "owner", permission: "finance.read" }]),
    ).toBe(false);
  });

  it("keeps defaults for role tokens without override rows", () => {
    const granted = permissionsForRole("owner, member", [
      { role: "member", permission: "finance.read" },
    ]);
    expect(granted.has("finance.read")).toBe(true);
    expect(granted.has("finance.write")).toBe(true);
  });
});
