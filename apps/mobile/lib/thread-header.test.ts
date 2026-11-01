import { expect, it, vi } from "vitest";
import { createThreadHeaderStyles } from "../components/thread-header-styles";
import { HEADER_CONTROL_SIZE } from "./native-controls";

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
  expect(titleCapsule.minHeight).toBe(HEADER_CONTROL_SIZE);
  expect(titleCapsule).not.toHaveProperty("paddingVertical");
});

it("pads the chat title 14 at its start and 10 at its end, mirrored for right-to-left", () => {
  const { titleCapsule } = createThreadHeaderStyles();
  expect(titleCapsule).toMatchObject({ paddingStart: 14, paddingEnd: 10 });
  for (const side of ["paddingHorizontal", "paddingLeft", "paddingRight"]) {
    expect(titleCapsule).not.toHaveProperty(side);
  }
});

it("fades the chat into the composer across the full screen width", () => {
  const { composerFade } = createThreadHeaderStyles();
  expect(composerFade).toMatchObject({ position: "absolute", left: 0, right: 0, bottom: "100%" });
});

it("uses a borderless fallback title fill and leaves the header buttons clear", () => {
  const styles = createThreadHeaderStyles();
  expect(styles.titleCapsuleFill).not.toHaveProperty("borderWidth");
  expect(styles.statusBarFade).not.toHaveProperty("backgroundColor");
});

it("lets a long chat name give way to the avatars beside it", () => {
  const { title } = createThreadHeaderStyles();
  expect(title.flexShrink).toBe(1);
});

it("sets the chat title in medium 17 on a 22 line, in the text colour", () => {
  const { title } = createThreadHeaderStyles();
  expect(title).toMatchObject({
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "500",
    color: "foreground",
  });
});
