import { expect, it } from "vitest";
import { pageImageNames } from "./page-images.js";

it("reads picture references only where one starts, not image: inside another word", () => {
  const source = `<Image src="image:hotel" />{"background-image:linear-gradient(red, blue)"}{\`image:beach\`}`;
  expect([...pageImageNames(source)]).toEqual(["hotel", "beach"]);
});
