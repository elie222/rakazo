// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  download: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("../../lib/pages/artifact-open", () => ({
  fetchArtifactBytes: mocks.fetch,
  downloadArtifact: mocks.download,
  downloadArtifactBytes: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    `«${strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "")}»`,
}));
vi.mock("./PdfViewer", () => ({ PdfViewer: () => null }));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("./SandboxedHtmlViewer", () => ({ SandboxedHtmlViewer: () => <iframe title="HTML" /> }));

import { ArtifactFileCard } from "./ArtifactFileCard";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = mocks.create;
      static override revokeObjectURL = mocks.revoke;
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockReturnValue("blob:audio-preview");
  mocks.revoke.mockReset();
  mocks.fetch.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.download.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"])(
  "renders %s controls, keeps download, and revokes playback URL",
  async (mimeType) => {
    await act(async () =>
      root?.render(
        <ArtifactFileCard
          target={{ botId: "bot-1" }}
          artifactId="audio-1"
          name="clip"
          mimeType={mimeType}
          size={3}
        />,
      ),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(container.querySelector("audio")).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')?.click(),
    );
    const audio = container.querySelector("audio");
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(audio?.getAttribute("aria-label")).toBe("clip");
    expect(audio?.getAttribute("src")).toBe("blob:audio-preview");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[0].type).toBe(mimeType);
    expect(mocks.fetch).toHaveBeenCalledWith({ botId: "bot-1" }, "audio-1");
    const download = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download clip"]',
    );
    expect(download).not.toBeNull();
    await act(async () => download?.click());
    expect(mocks.download).toHaveBeenCalledWith({ botId: "bot-1" }, "audio-1", "clip", mimeType);
    await act(async () => root?.unmount());
    root = undefined;
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("blob:audio-preview");
  },
);
it("retains the download control when playback bytes fail to load", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () =>
    root?.render(
      <ArtifactFileCard
        target={{ groupId: "group-1" }}
        artifactId="audio-1"
        name="clip"
        mimeType="audio/mpeg"
        size={3}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')?.click(),
  );
  expect(container.querySelector("audio")).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Download clip"]')).not.toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Download clip"]')?.click(),
  );
  expect(mocks.download).toHaveBeenCalledWith(
    { groupId: "group-1" },
    "audio-1",
    "clip",
    "audio/mpeg",
  );
});

function renderClip(artifactId = "audio-1") {
  root?.render(
    <ArtifactFileCard
      target={{ groupId: "group-1" }}
      artifactId={artifactId}
      name="clip"
      mimeType="audio/mpeg"
      size={3}
    />,
  );
}

it("downloads independently before playback", async () => {
  await act(async () => renderClip());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Download clip"]')?.click(),
  );
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(container.querySelector("audio")).toBeNull();
});

it.each(["unmount", "change"])(
  "ignores pending bytes after %s and suppresses duplicate play",
  async (cleanup) => {
    const bytes = deferred<Uint8Array>();
    mocks.fetch.mockReturnValueOnce(bytes.promise);
    await act(async () => renderClip());
    const play = container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')!;
    await act(async () => {
      play.click();
      play.click();
    });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ groupId: "group-1" }, "audio-1");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      if (cleanup === "change") renderClip("audio-2");
      else {
        root?.unmount();
        root = undefined;
      }
    });
    await act(async () => bytes.resolve(new Uint8Array([1])));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.querySelector("audio")).toBeNull();
  },
);

it("stops playback and revokes the old URL on artifact change", async () => {
  await act(async () => renderClip());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')?.click(),
  );
  await act(async () => renderClip("audio-2"));
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("blob:audio-preview");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  expect(container.querySelector("audio")).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("keeps controls when automatic playback is rejected", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("blocked"));
  await act(async () => renderClip());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')?.click(),
  );
  expect(container.querySelector("audio")?.hasAttribute("controls")).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("translates every size unit and rolls up instead of 1,024.0 KB or 1,536.0 MB", async () => {
  await act(async () =>
    root?.render(
      <>
        {[512, 1024, 1048575, 1610612736, 1.5 * 1024 ** 4].map((size) => (
          <ArtifactFileCard
            key={size}
            target={{ botId: "b" }}
            artifactId={`a${size}`}
            name={`f${size}.zip`}
            mimeType="application/zip"
            size={size}
          />
        ))}
      </>,
    ),
  );
  const sizes = [...container.querySelectorAll("button span:last-child")].map(
    (el) => el.textContent,
  );
  expect(sizes).toEqual(["«512 B»", "«1 KB»", "«1 MB»", "«1.5 GB»", "«1.5 TB»"]);
});

it("previews plain text in the app instead of only offering a download", async () => {
  mocks.fetch.mockResolvedValue(new TextEncoder().encode("1. Confirm the pricing page copy."));
  await act(async () =>
    root?.render(
      <ArtifactFileCard
        target={{ botId: "bot-1" }}
        artifactId="notes-1"
        name="notes.txt"
        mimeType="text/plain"
        size={33}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Preview notes.txt"]')?.click(),
  );
  await vi.waitFor(() =>
    expect(document.body.querySelector("pre")?.textContent).toBe(
      "1. Confirm the pricing page copy.",
    ),
  );
});

it("retries failed audio loads in place without duplicate requests", async () => {
  const bytes = deferred<Uint8Array>();
  mocks.fetch
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("still offline"))
    .mockImplementationOnce(() => bytes.promise);
  await act(async () => renderClip());
  const play = () => container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')!;
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => play().click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(play()).not.toBeNull();
    expect(play().disabled).toBe(false);
  }
  await act(async () => {
    play().click();
    play().click();
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
  expect(play().disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => bytes.resolve(new Uint8Array([1, 2, 3])));
  expect(container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio-preview");
  expect(play()).toBeNull();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

it.each(["unmount", "change"])("ignores a rejected retry after %s", async (cleanup) => {
  const late = deferred<Uint8Array>();
  mocks.fetch
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => late.promise);
  await act(async () => renderClip());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')!.click(),
  );
  const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]');
  expect(retry).not.toBeNull();
  await act(async () => retry!.click());
  await act(async () => {
    if (cleanup === "change") renderClip("audio-2");
    else {
      root?.unmount();
      root = undefined;
    }
  });
  await act(async () => late.reject(new Error("late failure")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
  if (cleanup === "change") {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')!.click(),
    );
    expect(mocks.fetch).toHaveBeenLastCalledWith({ groupId: "group-1" }, "audio-2");
    expect(container.querySelector("audio")).not.toBeNull();
  }
});

async function openFilePreview(mimeType = "text/markdown") {
  await act(async () =>
    root?.render(
      <ArtifactFileCard
        target={{ botId: "bot-1" }}
        artifactId="file-1"
        name="notes.md"
        mimeType={mimeType}
        size={30}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Preview notes.md"]')!.click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

it.each(["text/markdown", "text/plain"])(
  "copies the raw %s source after loading",
  async (mimeType) => {
    const source = "# Notes\n\n**Raw** source";
    const loading = deferred<Uint8Array>();
    mocks.fetch.mockReturnValue(loading.promise);
    const dialog = await openFilePreview(mimeType);
    expect(dialog.querySelector('button[aria-label="Copy notes.md"]')).toBeNull();
    await act(async () => loading.resolve(new TextEncoder().encode(source)));
    const copy = dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy notes.md"]');
    expect(copy).not.toBeNull();
    await act(async () => copy!.click());
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(copy!.getAttribute("aria-label")).toBe("Copied");
  },
);

it("offers the source to copy by hand when the browser refuses", async () => {
  const source = "# Notes";
  mocks.fetch.mockResolvedValue(new TextEncoder().encode(source));
  mocks.writeText.mockRejectedValue(new Error("denied"));
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  const dialog = await openFilePreview("text/markdown");
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy notes.md"]')!.click(),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Copy notes.md"]')?.value,
    ).toBe(source),
  );
});

it.each(["text/html", "application/pdf", "video/mp4"])(
  "does not offer copy for %s",
  async (mimeType) => {
    mocks.fetch.mockResolvedValue(new TextEncoder().encode("<h1>Notes</h1>"));
    const dialog = await openFilePreview(mimeType);
    expect(dialog.querySelector('button[aria-label^="Copy"]')).toBeNull();
  },
);

it.each(["metaKey", "ctrlKey"])(
  "scopes %s+A from the dialog header to the file body",
  async (modifier) => {
    mocks.fetch.mockResolvedValue(new TextEncoder().encode("File contents"));
    const dialog = await openFilePreview();
    const button = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!;
    button.focus();
    const event = new KeyboardEvent("keydown", {
      key: "a",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe("File contents");
    expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(
      dialog.querySelector("article"),
    );
  },
);

it.each(["input", "textarea", "contenteditable"])(
  "preserves select-all inside %s",
  async (kind) => {
    mocks.fetch.mockResolvedValue(new TextEncoder().encode("File contents"));
    const dialog = await openFilePreview();
    const editable = document.createElement(kind === "contenteditable" ? "div" : kind);
    if (kind === "contenteditable") editable.setAttribute("contenteditable", "true");
    dialog.append(editable);
    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => editable.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  },
);
