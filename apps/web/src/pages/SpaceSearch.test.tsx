// @vitest-environment jsdom

import type { SearchHit } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { SpaceSearchResults } from "./SpaceSearch";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function file(artifactId: string): SearchHit {
  return {
    kind: "file",
    botId: "bot-1",
    botName: "Scout",
    title: `${artifactId}.png`,
    snippet: "image/png, 10 bytes",
    messageId: "message-1",
    seq: 4,
    artifactId,
  };
}

it("renders every file sent in one message without duplicate-key errors", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () =>
    root.render(
      <SpaceSearchResults
        hits={[file("artifact-1"), file("artifact-2")]}
        loading={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(error).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(2);
  expect(container.querySelector("button")?.textContent).toContain("File");
});
