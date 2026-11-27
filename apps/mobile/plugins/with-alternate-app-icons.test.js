import { APP_ICONS, DEFAULT_APP_ICON } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { alternateIcons } from "./with-alternate-app-icons.js";

it("builds every icon the picker offers", () => {
  expect(alternateIcons()).toEqual(APP_ICONS.filter((icon) => icon !== DEFAULT_APP_ICON).sort());
});
