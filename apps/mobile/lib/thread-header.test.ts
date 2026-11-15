import { expect, it, vi } from "vitest";
import {
  CHAT_HEADER_CONTROL_SIZE,
  createThreadHeaderStyles,
} from "../components/thread-header-styles";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 26 },
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
  }),
}));

it("sizes the chat title like the header buttons beside it", () => {
  const { titleCapsule } = createThreadHeaderStyles();
  expect(titleCapsule.minHeight).toBe(CHAT_HEADER_CONTROL_SIZE);
  expect(titleCapsule).not.toHaveProperty("paddingVertical");
});

it("pads the chat title 7 at its start and 19 at its end, mirrored for right-to-left", () => {
  const { titleCapsule } = createThreadHeaderStyles();
  expect(titleCapsule).toMatchObject({ paddingStart: 7, paddingEnd: 19 });
  for (const side of ["paddingHorizontal", "paddingLeft", "paddingRight"]) {
    expect(titleCapsule).not.toHaveProperty(side);
  }
});

it("lets a long chat name give way to the avatars beside it", () => {
  const { title } = createThreadHeaderStyles();
  expect(title.flexShrink).toBe(1);
});

it("sets the chat title in medium 18 on a 24 line, in the text colour", () => {
  const { title } = createThreadHeaderStyles();
  expect(title).toMatchObject({
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "500",
    color: "foreground",
  });
});
