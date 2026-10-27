import type { Actor } from "@rakazo/contracts";
import { hasPermission, permissionsForRole } from "@rakazo/db";
import { describe, expect, it } from "vitest";

const actor = (role: string): Actor => ({
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
  role,
});

describe("space RBAC hasPermission", () => {
  it("defaults owner to finance.read and finance.write", () => {
    expect(hasPermission(actor("owner"), "finance.read")).toBe(true);
    expect(hasPermission(actor("owner"), "finance.write")).toBe(true);
  });

  it("defaults member to finance.read only", () => {
    expect(hasPermission(actor("member"), "finance.read")).toBe(true);
    expect(hasPermission(actor("member"), "finance.write")).toBe(false);
  });

  it("honors SpaceRolePermission overrides for a role", () => {
    const overrides = [
      { role: "member", permission: "finance.read" },
      { role: "member", permission: "finance.write" },
    ];
    expect(hasPermission(actor("member"), "finance.write", overrides)).toBe(true);
    expect(
      permissionsForRole("owner", [{ role: "owner", permission: "finance.read" }]).has(
        "finance.write",
      ),
    ).toBe(false);
  });

  it("ignores unknown permission strings in overrides", () => {
    expect(
      hasPermission(actor("member"), "finance.read", [
        { role: "member", permission: "not-a-real-permission" },
      ]),
    ).toBe(false);
  });
});
