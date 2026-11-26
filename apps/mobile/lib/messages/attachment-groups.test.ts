import type { MessageBlock } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { attachmentGroups } from "./attachment-groups";

const image = (name: string, mimeType = "image/png"): MessageBlock => ({
  kind: "image",
  artifactId: `id-${name}`,
  name,
  mimeType,
});
const file: MessageBlock = {
  kind: "file",
  artifactId: "id-notes",
  mimeType: "text/plain",
  name: "notes.txt",
  size: 12,
};

const shape = (blocks: MessageBlock[]) =>
  attachmentGroups(blocks).map((group) =>
    group.kind === "pictures"
      ? group.pictures.map((picture) => picture.name)
      : group.attachment.name,
  );

it("stacks every run of inline pictures and keeps a lone picture single", () => {
  expect(
    shape([
      image("logo.svg", "image/svg+xml"),
      image("a.png"),
      image("b.png"),
      file,
      image("c.png"),
      { kind: "text", text: "and" },
      image("d.png"),
      image("e.svg", "image/svg+xml"),
      image("f.png"),
      image("g.png"),
    ]),
  ).toEqual([
    "logo.svg",
    ["a.png", "b.png"],
    "notes.txt",
    "c.png",
    "d.png",
    "e.svg",
    ["f.png", "g.png"],
  ]);
});
