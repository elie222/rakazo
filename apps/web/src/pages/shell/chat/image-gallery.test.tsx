// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/query/rpc";
import type { GalleryImage } from "./image-gallery";
import { ImageGalleryProvider, MessageImageRow, useOpenImage } from "./image-gallery";

vi.mock("../../../lib/query/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

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

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
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
  await press("ArrowRight", { altKey: true });
  const field = document.body.appendChild(document.createElement("input"));
  await press("ArrowRight", {}, field);
  field.remove();
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

it("closes when the empty surface beside the picture is clicked", async () => {
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={images}>
        <Opener image={images[0]!} />
      </ImageGalleryProvider>,
    );
  });
  await act(async () => {
    container.querySelector("button")?.click();
  });
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await act(async () => {
    dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps clipped thumbnails out of the tab order", async () => {
  const many: GalleryImage[] = Array.from({ length: 10 }, (_, index) => ({
    artifactId: `shot-${index}`,
    name: `shot-${index}`,
    target: { botId: "bot" },
  }));
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={many}>
        {many.map((image) => (
          <Opener key={image.name} image={image} />
        ))}
      </ImageGalleryProvider>,
    );
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "open shot-5")
      ?.click();
  });
  const thumb = (index: number) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Show shot-${index}"]`);
  expect(thumb(5)?.tabIndex).toBe(0);
  expect(thumb(4)?.tabIndex).toBe(0);
  expect(thumb(6)?.tabIndex).toBe(0);
  expect(thumb(3)?.tabIndex).toBe(-1);
  expect(thumb(7)?.tabIndex).toBe(-1);
});

it("fetches only thumbnails near the selected picture", async () => {
  const many: GalleryImage[] = Array.from({ length: 10 }, (_, index) => ({
    artifactId: `lazy-${index}`,
    name: `lazy-${index}`,
    target: { botId: "bot" },
  }));
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={many}>
        {many.map((image) => (
          <Opener key={image.name} image={image} />
        ))}
      </ImageGalleryProvider>,
    );
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "open lazy-5")
      ?.click();
  });
  await act(async () => {});
  expect(document.querySelectorAll('[aria-label^="Show "]')).toHaveLength(7);
  const fetched = [
    ...new Set(
      vi
        .mocked(rpc.artifacts.get)
        .mock.calls.map(([input]) => (input as { artifactId: string }).artifactId)
        .filter((id) => id.startsWith("lazy-")),
    ),
  ].sort();
  expect(fetched).toEqual(["lazy-2", "lazy-3", "lazy-4", "lazy-5", "lazy-6", "lazy-7", "lazy-8"]);
});

it("keeps the selected picture when earlier images arrive", async () => {
  const first: GalleryImage[] = ["a", "b", "c"].map((name) => ({
    artifactId: name,
    name,
    target: { botId: "bot" },
  }));
  const render = async (list: GalleryImage[]) => {
    await act(async () => {
      root.render(
        <ImageGalleryProvider images={list}>
          {list.map((image) => (
            <Opener key={image.name} image={image} />
          ))}
        </ImageGalleryProvider>,
      );
    });
  };
  await render(first);
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "open b")
      ?.click();
  });
  expect(previewName()).toBe("b");
  await render([{ artifactId: "x", name: "x", target: { botId: "bot" } }, ...first]);
  expect(previewName()).toBe("b");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("3 / 4");
});

it("draws a message's pictures as one row and counts the ones it leaves out", async () => {
  const many: GalleryImage[] = ["one", "two", "three", "four", "five"].map((name) => ({
    artifactId: name,
    name: `${name}.png`,
    target: { botId: "bot" },
  }));
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={many}>
        <MessageImageRow images={many} />
      </ImageGalleryProvider>,
    );
  });
  const tiles = [...container.querySelectorAll("button")];
  expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
    "Show one.png",
    "Show two.png",
    "Show all 5 pictures",
  ]);
  expect(tiles[2]?.textContent).toBe("+3");
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // Each tile opens its own picture, so a run never lands on the wrong one.
  for (const [index, name] of ["one.png", "two.png", "three.png"].entries()) {
    await act(async () => {
      tiles[index]?.click();
    });
    expect(previewName()).toBe(name);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`${index + 1} / 5`);
    await press("Escape");
  }
});

it("waits for the row to come near the viewport before downloading its pictures", async () => {
  const observers: IntersectionObserverCallback[] = [];
  class FakeObserver {
    constructor(callback: IntersectionObserverCallback) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver as unknown as typeof IntersectionObserver);
  vi.mocked(rpc.artifacts.get).mockClear();
  const pair: GalleryImage[] = ["one", "two"].map((name) => ({
    artifactId: name,
    name: `${name}.png`,
    target: { botId: "bot" },
  }));
  await act(async () => {
    root.render(
      <ImageGalleryProvider images={pair}>
        <MessageImageRow images={pair} />
      </ImageGalleryProvider>,
    );
  });
  // A tile still shows which picture it stands for while it waits.
  expect(container.textContent).toContain("one.png");
  expect(vi.mocked(rpc.artifacts.get)).not.toHaveBeenCalled();

  await act(async () => {
    observers[0]?.([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  });
  expect(vi.mocked(rpc.artifacts.get)).toHaveBeenCalledTimes(2);
});
