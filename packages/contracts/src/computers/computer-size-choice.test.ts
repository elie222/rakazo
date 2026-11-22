import { describe, expect, it } from "vitest";
import { applySavedCloudComputerSize, computerSizeChoice } from "./computer.js";

describe("computerSizeChoice", () => {
  const upToLarge = ["standard", "large"] as const;

  it("saves a different size the plan includes", () => {
    expect(computerSizeChoice("large", { savedSize: "standard" }, upToLarge)).toBe("save");
  });

  it("does nothing for the size already saved", () => {
    expect(computerSizeChoice("standard", { savedSize: "standard" }, upToLarge)).toBe("unchanged");
  });

  it("asks to upgrade for a size the plan excludes, even the one still saved", () => {
    expect(computerSizeChoice("xlarge", { savedSize: "standard" }, upToLarge)).toBe("upgrade");
    expect(computerSizeChoice("xlarge", { savedSize: "xlarge" }, upToLarge)).toBe("upgrade");
  });

  it("saves the size a smaller plan holds a computer at in place of its larger saved size", () => {
    expect(computerSizeChoice("large", { savedSize: "xlarge" }, upToLarge)).toBe("save");
  });
});

it("does not write a confirmed size for a computer missing from the cached list", () => {
  expect(applySavedCloudComputerSize(undefined, "c1", "large")).toBeUndefined();
  expect(applySavedCloudComputerSize(null, "c1", "large")).toBeUndefined();
  expect(
    applySavedCloudComputerSize(
      {
        available: ["standard", "large"],
        canManage: true,
        computers: [
          { id: "c2", scope: "team", botName: null, size: "standard", savedSize: "standard" },
        ],
      },
      "c1",
      "large",
    ),
  ).toBeUndefined();
});
