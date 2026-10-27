import type { Actor, SpacePermission } from "@rakazo/contracts";
import { DEFAULT_ROLE_PERMISSIONS } from "@rakazo/contracts";

export type RolePermissionRow = {
  role: string;
  permission: string;
};

/** Split Better Auth–style comma-separated role strings into tokens. */
export function spaceRoleTokens(role: string): string[] {
  return role
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Resolve the permission set for a space role.
 * When `overrides` includes any row whose role token matches, only those
 * permissions are used for that token; otherwise product defaults apply.
 */
export function permissionsForRole(
  role: string,
  overrides?: Iterable<RolePermissionRow> | null,
): Set<SpacePermission> {
  const tokens = spaceRoleTokens(role);
  const granted = new Set<SpacePermission>();
  const overrideByRole = new Map<string, Set<string>>();
  if (overrides) {
    for (const row of overrides) {
      const key = row.role.trim();
      if (!key) continue;
      let set = overrideByRole.get(key);
      if (!set) {
        set = new Set();
        overrideByRole.set(key, set);
      }
      set.add(row.permission);
    }
  }
  for (const token of tokens) {
    const custom = overrideByRole.get(token);
    if (custom) {
      for (const permission of custom) {
        if (permission === "finance.read" || permission === "finance.write") {
          granted.add(permission);
        }
      }
      continue;
    }
    for (const permission of DEFAULT_ROLE_PERMISSIONS[token] ?? []) {
      granted.add(permission);
    }
  }
  return granted;
}

export function hasPermission(
  actor: Actor,
  permission: SpacePermission,
  overrides?: Iterable<RolePermissionRow> | null,
): boolean {
  return permissionsForRole(actor.role, overrides).has(permission);
}
