import { expect, it } from "vitest";
import { galleryPictures } from "./gallery";

const picture = (name: string) => ({
  artifactId: `id-${name}`,
  name,
  mimeType: "image/png",
});

it("reads the pictures of the message that opened the viewer", () => {
  const raw = JSON.stringify([picture("one.png"), picture("two.png")]);
  expect(galleryPictures(raw)).toEqual([picture("one.png"), picture("two.png")]);
});

it("opens alone when the message carried one picture or the list is unusable", () => {
  expect(galleryPictures(JSON.stringify([picture("one.png")]))).toBeUndefined();
  expect(galleryPictures("")).toBeUndefined();
  expect(galleryPictures("not json")).toBeUndefined();
  expect(galleryPictures(JSON.stringify({ artifactId: "id-one" }))).toBeUndefined();
});

it("keeps only entries that name a picture", () => {
  const raw = JSON.stringify([picture("one.png"), { artifactId: "id-two" }, picture("three.png")]);
  expect(galleryPictures(raw)).toEqual([picture("one.png"), picture("three.png")]);
});
