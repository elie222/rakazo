import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PLOT_TOOL_GUIDE } from "./plot-guide.prompt.js";

it("keeps the plot guide text exact", () => {
  expect(createHash("sha256").update(PLOT_TOOL_GUIDE).digest("hex")).toMatchInlineSnapshot(
    `"a512db717eefaa009b3231919fada57d69063c3483f196fbfffcdc77b35f8854"`,
  );
});
