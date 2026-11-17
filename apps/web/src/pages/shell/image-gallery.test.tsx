// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import type { GalleryImage } from "./image-gallery";
import { ImageGalleryProvider, useOpenImage } from "./image-gallery";

vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

const images: GalleryImage[] = ["one", "two", "three"].map((name) => ({
  artifactId: name,
  name,
  target: { botId: "bot" },
}));

function Opener({ image }: { image: GalleryImage }) {
  const open = useOpenImage();
  return (
    <button type="button" onClick={() => open?.(image)}>
      {`open ${image.name}`}
    </button>
  );
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:image",
    revokeObjectURL: () => undefined,
  });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(rpc.artifacts.get).mockResolvedValue({
    contentBase64: btoa("image"),
    mimeType: "image/png",
  } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(rpc.artifacts.get).mockReset();
});

function previewName() {
  return document.querySelector('[role="dialog"] img')?.getAttribute("alt");
}

async function press(key: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

it("moves through the chat's images with the arrow keys and the carousel", async () => {
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={images}>
        {images.map((image) => (
          <Opener key={image.name} image={image} />
        ))}
      </ImageGalleryProvider>,
    );
  });
  await act(async () => {
    container.querySelectorAll("button")[1]?.click();
  });
  expect(previewName()).toBe("two");

  await press("ArrowRight");
  expect(previewName()).toBe("three");
  await press("ArrowRight");
  expect(previewName()).toBe("one");
  await press("ArrowLeft");
  expect(previewName()).toBe("three");

  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Show one"]')?.click();
  });
  expect(previewName()).toBe("one");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 / 3");
});

it("opens a lone image without navigation", async () => {
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={[images[0]!]}>
        <Opener image={images[0]!} />
      </ImageGalleryProvider>,
    );
  });
  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(previewName()).toBe("one");
  expect(document.querySelector('[aria-label="Next image"]')).toBeNull();
  expect(document.querySelector('[aria-label="Show one"]')).toBeNull();
});
