import { expect, it, vi } from "vitest";
import { createThreadHeaderStyles } from "../components/thread-header-styles";
import { HEADER_CONTROL_SIZE } from "./native-controls";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 26 },
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({ background: "background", border: "border", card: "card" }),
}));

it("sizes the chat title like the header buttons beside it", () => {
  const { titleCapsule } = createThreadHeaderStyles();
  expect(titleCapsule.minHeight).toBe(HEADER_CONTROL_SIZE);
  expect(titleCapsule).not.toHaveProperty("paddingVertical");
});
