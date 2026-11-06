// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCopyText } from "./copy-text";

/** Clipboard writes the test settles by hand, so results can arrive out of click order. */
function manualClipboard() {
  const writes: Array<{ resolve: () => void; reject: () => void }> = [];
  return {
    writes,
    writeText: (_text: string) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject });
      }),
  };
}

function CopyProbe() {
  const [copied, copy, failed, , failedText] = useCopyText();
  return (
    <>
      <button type="button" onClick={() => copy("text")}>
        copy
      </button>
      <span data-copied={String(copied)} data-failed={String(failed)} data-text={failedText} />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CopyProbe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(navigator, "clipboard");
});

it("keeps the newer copy's success when an older copy fails after it", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  // The selection fallback also fails, so the older attempt really resolves as a failure.
  document.execCommand = vi.fn(() => false);
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(clipboard.writes).toHaveLength(2);
  expect(status()?.dataset.copied).toBe("true");
  expect(status()?.dataset.failed).toBe("false");
  expect(status()?.dataset.text).toBe("");
});

it("drops the earlier confirmation while a newer copy is still pending", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const button = container.querySelector<HTMLButtonElement>("button");
  const status = () => container.querySelector<HTMLElement>("span");

  await act(async () => button?.click());
  await act(async () => clipboard.writes[0]?.resolve());
  expect(status()?.dataset.copied).toBe("true");

  await act(async () => button?.click());
  expect(status()?.dataset.copied).toBe("false");
});

it("does not let a superseded copy fall back to selection over the newer text", async () => {
  const clipboard = manualClipboard();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard.writeText },
    configurable: true,
  });
  const execCommand = vi.fn(() => true);
  document.execCommand = execCommand;
  const button = container.querySelector<HTMLButtonElement>("button");

  await act(async () => button?.click());
  await act(async () => button?.click());
  const [first, second] = clipboard.writes;
  await act(async () => second?.resolve());
  await act(async () => first?.reject());

  expect(execCommand).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLElement>("span")?.dataset.copied).toBe("true");
});
