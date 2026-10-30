import { BotRuntimeProfile } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { createRunProfileSnapshot, parseRunProfileSnapshot } from "./run-profile-snapshot.js";

describe("run profile snapshots", () => {
  it("captures parsed profile settings and revision", () => {
    expect(createRunProfileSnapshot(3, { persona: { persona: "Analyst" } })).toEqual({
      revision: 3,
      settings: BotRuntimeProfile.parse({ persona: { persona: "Analyst" } }),
    });
  });
  it("reuses a persisted snapshot without reading a newer profile", () => {
    const original = createRunProfileSnapshot(2, { persona: { persona: "Original" } });
    expect(parseRunProfileSnapshot(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
  it("treats no snapshot as absent and rejects malformed snapshots", () => {
    expect(parseRunProfileSnapshot(null)).toBeNull();
    expect(() => parseRunProfileSnapshot({ revision: -1, settings: {} })).toThrow();
  });
});
