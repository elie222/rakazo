// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../query/rpc";
import type { ArtifactTarget } from "./artifact-open";
import type { ArtifactImageKeeper, ArtifactPicture } from "./use-artifact-image";
import {
  createArtifactImageKeeper,
  useArtifactImage,
  useArtifactImageKeeper,
} from "./use-artifact-image";

vi.mock("../query/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

let container: HTMLDivElement;
let root: Root;
const createObjectURL = vi.fn(() => "blob:photo");
const revokeObjectURL = vi.fn();
const artifact = { contentBase64: "AA==", mimeType: "image/png" };

function Image({ target, enabled = true }: { target: ArtifactTarget; enabled?: boolean }) {
  const src = useArtifactImage(target, "photo", enabled);
  return src ? <img src={src} alt="" /> : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.mocked(rpc.artifacts.get).mockResolvedValue(artifact as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shares pending and completed downloads until the last consumer leaves", async () => {
  const finish = deferred<never>();
  vi.mocked(rpc.artifacts.get).mockReturnValue(finish.promise);
  act(() =>
    root.render(
      <>
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  await act(async () => finish.resolve(artifact as never));
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(container.querySelectorAll("img")).toHaveLength(2);
  await act(async () =>
    root.render(
      <>
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  act(() => root.render(<Image target={{ botId: "bot" }} />));
  expect(revokeObjectURL).not.toHaveBeenCalled();
  act(() => root.render(null));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:photo");
});

it("separates bot and group scopes and skips disabled consumers", async () => {
  await act(async () =>
    root.render(
      <>
        <Image target={{ botId: "same" }} />
        <Image target={{ groupId: "same" }} />
        <Image target={{ botId: "other" }} enabled={false} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
  expect(rpc.artifacts.get).toHaveBeenCalledWith({ botId: "same", artifactId: "photo" });
  expect(rpc.artifacts.get).toHaveBeenCalledWith({ groupId: "same", artifactId: "photo" });
});

it("releases a download that finishes after all consumers unmount", async () => {
  const finish = deferred<never>();
  vi.mocked(rpc.artifacts.get).mockReturnValue(finish.promise);
  act(() => root.render(<Image target={{ botId: "bot" }} />));
  act(() => root.render(null));
  await act(async () => finish.resolve(artifact as never));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:photo");
  vi.mocked(rpc.artifacts.get).mockResolvedValue(artifact as never);
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
});

it("allows retrying a failed download after its consumers leave", async () => {
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).toBeNull();
  act(() => root.render(null));
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).not.toBeNull();
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
});

it("retries a failed download while its original consumer stays mounted", async () => {
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<Image key="first" target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).toBeNull();
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();

  await act(async () =>
    root.render(
      <>
        <Image key="first" target={{ botId: "bot" }} />
        <Image key="second" target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo");
});

const picture = (artifactId: string): ArtifactPicture => ({ target: { botId: "bot" }, artifactId });

/** Answers each picture with the given size, under an address that names it: blob:image/a. */
function answerSizes(sizes: Record<string, number>) {
  vi.mocked(rpc.artifacts.get).mockImplementation(({ artifactId }) =>
    Promise.resolve({
      contentBase64: btoa("\0".repeat(sizes[artifactId] ?? 1)),
      mimeType: `image/${artifactId}`,
    } as never),
  );
  const revokeObjectURL = vi.fn<(url: string) => void>();
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => `blob:${blob.type}`,
    revokeObjectURL,
  });
  return revokeObjectURL;
}
const revoked = (revokeObjectURL: Mock<(url: string) => void>) =>
  revokeObjectURL.mock.calls.map(([url]) => url);

/** Holds each picture's download open until the test lets it succeed or fail. */
function holdDownloads(sizes: Record<string, number>) {
  const gates = new Map<
    string,
    {
      resolve: (value: { contentBase64: string; mimeType: string }) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  vi.mocked(rpc.artifacts.get).mockImplementation(({ artifactId }) => {
    const gate = deferred<{ contentBase64: string; mimeType: string }>();
    gates.set(artifactId, gate);
    return gate.promise as never;
  });
  const revokeObjectURL = vi.fn<(url: string) => void>();
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => `blob:${blob.type}`,
    revokeObjectURL,
  });
  const body = (artifactId: string) => ({
    contentBase64: btoa("\0".repeat(sizes[artifactId] ?? 1)),
    mimeType: `image/${artifactId}`,
  });
  return {
    revokeObjectURL,
    finish: async (artifactId: string) => {
      gates.get(artifactId)?.resolve(body(artifactId));
      await flush();
    },
    fail: async (artifactId: string) => {
      gates.get(artifactId)?.reject(new Error("unavailable"));
      await flush();
    },
  };
}

it("lets go of the least recently shown pictures once they pass its byte budget", async () => {
  const keeper = createArtifactImageKeeper(6);
  const revokeObjectURL = answerSizes({ a: 3, b: 3, c: 3, d: 3 });
  keeper.keep(picture("a"));
  keeper.keep(picture("b"));
  await flush();
  keeper.keep(picture("c"));
  await flush();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/a"]);
  keeper.keep(picture("a"));
  await flush();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/a", "blob:image/b"]);
  // c was shown again just before d, so a is now the least recent.
  keeper.keep(picture("c"));
  keeper.keep(picture("d"));
  await flush();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/a", "blob:image/b", "blob:image/a"]);
  keeper.release();
  expect(revoked(revokeObjectURL)).toEqual([
    "blob:image/a",
    "blob:image/b",
    "blob:image/a",
    "blob:image/c",
    "blob:image/d",
  ]);
});

it("keeps a picture larger than its whole budget on its own", async () => {
  const keeper = createArtifactImageKeeper(6);
  const revokeObjectURL = answerSizes({ small: 3, big: 10, next: 3 });
  keeper.keep(picture("small"));
  await flush();
  keeper.keep(picture("big"));
  await flush();
  // Letting it go would only download it again on every return.
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/small"]);
  keeper.keep(picture("next"));
  await flush();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/small", "blob:image/big"]);
  keeper.release();
  expect(revoked(revokeObjectURL)).toEqual([
    "blob:image/small",
    "blob:image/big",
    "blob:image/next",
  ]);
});

it("keeps the new download when a failed one is retried", async () => {
  const keeper = createArtifactImageKeeper(1);
  const revokeObjectURL = answerSizes({ photo: 1 });
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  keeper.keep(picture("photo"));
  await flush();
  keeper.keep(picture("photo"));
  await flush();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  keeper.release();
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image/photo");
});

it("keeps an over-budget picture when the next download fails", async () => {
  const keeper = createArtifactImageKeeper(6);
  const revokeObjectURL = answerSizes({ big: 10, next: 1 });
  keeper.keep(picture("big"));
  await flush();
  const downloads = () => vi.mocked(rpc.artifacts.get).mock.calls.length;
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  keeper.keep(picture("next"));
  await flush();
  // The failure added no bytes, so the picture already held stays downloaded.
  expect(revoked(revokeObjectURL)).toEqual([]);
  const afterFailure = downloads();
  keeper.keep(picture("big"));
  await flush();
  expect(downloads()).toBe(afterFailure);
  expect(revoked(revokeObjectURL)).toEqual([]);
  // The failed download was dropped, so asking again starts a new one.
  keeper.keep(picture("next"));
  expect(downloads()).toBe(afterFailure + 1);
  await flush();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/big"]);
  keeper.release();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/big", "blob:image/next"]);
});

it("does not trim again when a dropped download finishes", async () => {
  const keeper = createArtifactImageKeeper(6);
  const { revokeObjectURL, finish, fail } = holdDownloads({ stale: 3, big: 10, newer: 3 });
  keeper.keep(picture("big"));
  await finish("big");
  keeper.keep(picture("stale"));
  keeper.keep(picture("newer"));
  // The picture leaves the gallery while its download is still running.
  keeper.retainOnly([picture("big"), picture("newer")]);
  await finish("stale");
  await fail("newer");
  // That late completion must not push out the picture already in hand.
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/stale"]);
  const calls = vi.mocked(rpc.artifacts.get).mock.calls.length;
  keeper.keep(picture("big"));
  await flush();
  expect(vi.mocked(rpc.artifacts.get).mock.calls.length).toBe(calls);
  keeper.release();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/stale", "blob:image/big"]);
});

it("keeps an oversized picture while a newer download is still pending", async () => {
  const keeper = createArtifactImageKeeper(6);
  const { revokeObjectURL, finish, fail } = holdDownloads({ big: 10, thumb: 3 });
  keeper.keep(picture("big"));
  keeper.keep(picture("thumb"));
  await finish("big");
  expect(revoked(revokeObjectURL)).toEqual([]);
  await fail("thumb");
  expect(revoked(revokeObjectURL)).toEqual([]);
  const calls = vi.mocked(rpc.artifacts.get).mock.calls.length;
  keeper.keep(picture("big"));
  await flush();
  expect(vi.mocked(rpc.artifacts.get).mock.calls.length).toBe(calls);
  keeper.release();
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/big"]);
});

/** A picture on screen: in the lightbox with a keeper, in the chat behind it without one. */
function Shown({ picture, keeper }: { picture: ArtifactPicture; keeper?: ArtifactImageKeeper }) {
  const src = useArtifactImage(picture.target, picture.artifactId, true, keeper);
  return src ? <img src={src} alt={picture.artifactId} /> : null;
}

/** The keeper's owner, laid out as the lightbox is: it keeps every picture and shows some. */
function Gallery({
  pictures,
  shown,
  maxBytes,
}: {
  pictures: ArtifactPicture[];
  shown: ArtifactPicture[];
  maxBytes: number;
}) {
  const keeper = useArtifactImageKeeper(pictures, maxBytes);
  return (
    <>
      {/* The chat behind the lightbox shows this one all along, without the keeper. */}
      <Shown key="chat" picture={fresh} />
      {shown.map((picture) => (
        <Shown key={picture.artifactId} picture={picture} keeper={keeper} />
      ))}
    </>
  );
}

// Three pictures with their sizes: a small one, a big one, and one the chat shows all along.
const x = picture("x");
const big = picture("big");
const fresh = picture("fresh");
const budget = 14;

async function renderGallery(pictures: ArtifactPicture[], shown: ArtifactPicture[]) {
  await act(async () => {
    root.render(
      // StrictMode, as the app runs in development.
      <StrictMode>
        <Gallery pictures={pictures} shown={shown} maxBytes={budget} />
      </StrictMode>,
    );
  });
}

it("makes room for a newly shown picture with the one that left, not with one that still fits", async () => {
  const revokeObjectURL = answerSizes({ x: 3, big: 10, fresh: 2 });
  await renderGallery([x, big], [x, big]);
  // Both leave the lightbox and stay downloaded only because it keeps them.
  await renderGallery([x, big], []);
  expect(revoked(revokeObjectURL)).toEqual([]);
  // The chat drops the big one, and the same commit shows a picture the chat has had all along.
  await renderGallery([x, fresh], [fresh]);
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/big"]);
  // x still fits, so coming back to it finds it downloaded.
  await renderGallery([x, fresh], [x, fresh]);
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/big"]);
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(3);
});

it("lets go of the least recently shown picture when a newly shown one goes over the budget", async () => {
  const revokeObjectURL = answerSizes({ x: 3, big: 10, fresh: 2 });
  await renderGallery([x, big], [x, big]);
  await renderGallery([x, big], []);
  // The chat has already downloaded this one, so its size counts as soon as the lightbox shows it.
  await renderGallery([x, big, fresh], [fresh]);
  expect(revoked(revokeObjectURL)).toEqual(["blob:image/x"]);
});
