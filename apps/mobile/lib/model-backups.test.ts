import { describe, expect, it } from "vitest";
import { mobileBackupScopeIsCurrent } from "./model-backups";

describe("mobile backup scope", () => {
  it("rejects stale user or Space responses", () => {
    const validScope = {
      expectedUserId: "user-a",
      expectedSpaceId: "space-a",
      currentUserId: "user-a",
      currentSpaceId: "space-a",
      selectedSpaceId: "space-a",
      requestGeneration: 4,
      currentGeneration: 4,
    };
    expect(mobileBackupScopeIsCurrent(validScope)).toBe(true);
    expect(mobileBackupScopeIsCurrent({ ...validScope, selectedSpaceId: null })).toBe(true);
    expect(mobileBackupScopeIsCurrent({ ...validScope, selectedSpaceId: "space-b" })).toBe(false);
    expect(mobileBackupScopeIsCurrent({ ...validScope, currentUserId: "user-b" })).toBe(false);
    expect(mobileBackupScopeIsCurrent({ ...validScope, currentSpaceId: "space-b" })).toBe(false);
    expect(mobileBackupScopeIsCurrent({ ...validScope, requestGeneration: 3 })).toBe(false);
  });
});
