import { i18n } from "@lingui/core";
import { expect, it } from "vitest";
import { computerUsageDetails } from "./computer-usage.js";

it("shows a failed refresh in place of the previously loaded hours", () => {
  i18n.activate("en");
  const data = { computers: [], otherHours: 2 };
  expect(computerUsageDetails({ data, isError: false }, "en").rows).toHaveLength(1);
  expect(computerUsageDetails({ data, isError: true }, "en")).toEqual({
    rows: [],
    message: "Could not load computer hours",
  });
});
