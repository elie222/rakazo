// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../query/rpc";
import type { ArtifactTarget } from "./artifact-open";
import { useArtifactImage, useArtifactImageKeeper } from "./use-artifact-image";

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
  createObjectURL.mockReturnValue("blob:photo");
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

const bot = { botId: "bot" };
const pictures = ["a", "b", "c", "large"].map((artifactId) => ({ target: bot, artifactId }));

function CachedImage({
  selected,
  available = pictures,
}: {
  selected: string;
  available?: typeof pictures;
}) {
  const keeper = useArtifactImageKeeper(available, 6);
  const src = useArtifactImage(bot, selected, true, keeper);
  return src ? <img src={src} alt={selected} /> : null;
}

function answerSizes() {
  vi.mocked(rpc.artifacts.get).mockImplementation(
    async ({ artifactId }) =>
      ({
        contentBase64: btoa("\0".repeat(artifactId === "large" ? 10 : 3)),
        mimeType: `image/${artifactId}`,
      }) as never,
  );
  createObjectURL.mockImplementation((blob?: Blob) => `blob:${blob?.type}`);
}

async function show(selected: string) {
  await act(async () => root.render(<CachedImage selected={selected} />));
}

it("evicts the least recently opened slide when the cache goes over its byte budget", async () => {
  answerSizes();
  await show("a");
  await show("b");
  await show("a");
  await show("c");
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(3);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image/b");
});

it("keeps an oversized slide until another slide loads", async () => {
  answerSizes();
  await show("large");
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  await show("a");
  expect(revokeObjectURL).not.toHaveBeenCalled();
  await show("b");
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image/large");
});

it("does not cache a slide that finishes after the user has moved on", async () => {
  answerSizes();
  const pending = deferred<never>();
  vi.mocked(rpc.artifacts.get).mockReturnValueOnce(pending.promise);
  await show("a");
  await show("b");
  await act(async () => pending.resolve(artifact as never));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image/png");
});

it("does not retain a pending download after the gallery removes its slide", async () => {
  answerSizes();
  const pending = deferred<never>();
  vi.mocked(rpc.artifacts.get).mockReturnValueOnce(pending.promise);
  await show("a");
  const available = pictures.slice(1);
  await act(async () => root.render(<CachedImage selected="a" available={available} />));
  await act(async () => pending.resolve(artifact as never));
  await act(async () => root.render(<CachedImage selected="b" available={available} />));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image/png");
});
