import { describe, expect, it } from "vitest";
import { createExperiments } from "./experiments.js";

const catalog = { "fixture-test": ["control", "treatment"] } as const;

describe("experiments", () => {
  it("shows everyone the control unless the experiment is running", () => {
    for (const running of [undefined, "", "unknown-test"]) {
      const experiments = createExperiments(running, catalog);
      expect(experiments.variant("fixture-test", "org-1")).toBe("control");
      expect(experiments.tags("fixture-test", "org-1")).toBeUndefined();
    }
  });

  it("keeps each subject on one variant and splits subjects about evenly", () => {
    const experiments = createExperiments("other, fixture-test", catalog);
    const ids = Array.from({ length: 2000 }, (_, index) => `org-${index}`);
    const variants = ids.map((id) => experiments.variant("fixture-test", id));
    expect(variants).toEqual(ids.map((id) => experiments.variant("fixture-test", id)));
    const treated = variants.filter((variant) => variant === "treatment").length;
    expect(treated).toBeGreaterThan(900);
    expect(treated).toBeLessThan(1100);
    expect(experiments.tags("fixture-test", "org-1")).toEqual({
      "fixture-test": experiments.variant("fixture-test", "org-1"),
    });
  });
});
