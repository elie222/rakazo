// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (options: Parameters<typeof actual.default>[0]) => {
      parses.count += 1;
      return actual.default(options);
    },
  };
});

it("draws finished text again without parsing it again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const text = "A **reused** message with a [link](https://example.test).";

  await act(async () => root.render(<ChatMarkdown>{text}</ChatMarkdown>));
  const firstHtml = container.innerHTML;
  await act(async () => root.render(null));
  await act(async () => root.render(<ChatMarkdown>{text}</ChatMarkdown>));
  expect(parses.count).toBe(1);
  expect(container.innerHTML).toBe(firstHtml);

  await act(async () => root.render(<ChatMarkdown streaming>{`${text} More`}</ChatMarkdown>));
  await act(async () => root.render(<ChatMarkdown streaming>{`${text} More text`}</ChatMarkdown>));
  expect(parses.count).toBeGreaterThan(1);
  await act(async () => root.unmount());
});
