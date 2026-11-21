// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ArtifactOpen from "../../lib/pages/artifact-open";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

const preview = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());

vi.mock("../../lib/query/rpc", () => {
  const rpc = { computer: { preview } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/pages/artifact-open", async (importOriginal) => ({
  ...(await importOriginal<typeof ArtifactOpen>()),
  downloadArtifactBytes: download,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));

import { SaveScreenshotButton, screenshotFileName } from "./SaveScreenshotButton";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SaveScreenshotButton botId="bot-1" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  preview.mockReset();
  download.mockReset();
  vi.unstubAllGlobals();
});

function button() {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Save screenshot"]')!;
}

const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null;

it("saves what the bot's screen shows right now under a dated name", async () => {
  preview.mockResolvedValue({ image: "data:image/png;base64,AQID" });
  await act(async () => button().click());
  expect(preview).toHaveBeenCalledExactlyOnceWith({ botId: "bot-1" });
  const [name, mimeType, bytes] = download.mock.calls[0] as [string, string, Uint8Array];
  expect(name).toMatch(/^screen-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
  expect(mimeType).toBe("image/png");
  expect([...bytes]).toEqual([1, 2, 3]);
  expect(alert()).toBeNull();
});

it("names the file for the image type the computer sent", () => {
  // Local time, as the user's own clock shows it.
  const at = new Date(2026, 2, 4, 5, 6, 7, 890);
  expect(screenshotFileName("image/png", at)).toBe("screen-2026-03-04-05-06-07.png");
  expect(screenshotFileName("image/jpeg", at)).toBe("screen-2026-03-04-05-06-07.jpg");
  expect(screenshotFileName("image/webp", at)).toBe("screen-2026-03-04-05-06-07.webp");
  expect(screenshotFileName("image/svg+xml", at)).toBe("screen-2026-03-04-05-06-07.svg");
});

it("says so, and saves nothing, when the computer has no screen to show", async () => {
  preview.mockResolvedValueOnce({ image: null });
  await act(async () => button().click());
  expect(alert()).toBe("Could not save screenshot");
  expect(download).not.toHaveBeenCalled();

  // A later try that works clears the message.
  preview.mockResolvedValueOnce({ image: "data:image/png;base64,AQID" });
  await act(async () => button().click());
  expect(alert()).toBeNull();
  expect(download).toHaveBeenCalledOnce();
});

it("says so when the request fails, and refuses something that is not an image", async () => {
  preview.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button().click());
  expect(alert()).toBe("Could not save screenshot");

  preview.mockResolvedValueOnce({ image: "data:text/html;base64,AQID" });
  await act(async () => button().click());
  expect(alert()).toBe("Could not save screenshot");
  expect(download).not.toHaveBeenCalled();
});

it("takes one picture however fast it is pressed", async () => {
  const answer = deferred<{ image: string }>();
  preview.mockReturnValue(answer.promise);
  await act(async () => {
    button().click();
    button().click();
  });
  expect(preview).toHaveBeenCalledOnce();
  expect(button().disabled).toBe(true);
  await act(async () => answer.resolve({ image: "data:image/png;base64,AQID" }));
  expect(download).toHaveBeenCalledOnce();
  expect(button().disabled).toBe(false);
});

it("saves nothing when the view closes before the picture arrives", async () => {
  const answer = deferred<{ image: string }>();
  preview.mockReturnValue(answer.promise);
  await act(async () => button().click());
  act(() => root.render(null));
  await act(async () => answer.resolve({ image: "data:image/png;base64,AQID" }));
  expect(download).not.toHaveBeenCalled();
});
