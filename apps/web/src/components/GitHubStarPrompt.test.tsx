// @vitest-environment jsdom
import { Toaster } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  recordMessageSent,
  resetStarPromptSessionForTests,
  STAR_PROMPT_DISMISSED_KEY,
  STAR_PROMPT_FIRST_SENT_KEY,
  STAR_PROMPT_SENT_KEY,
} from "./GitHubStarPrompt";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  localStorage.clear();
  resetStarPromptSessionForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Toaster />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const prompt = () => document.querySelector('[aria-label="Star on GitHub"]');

const START = Date.UTC(2026, 0, 1);
const LATER = START + 30 * 60_000;

async function send(times: number, now = LATER) {
  for (let i = 0; i < times; i++) await act(async () => recordMessageSent(now));
}

it("waits 30 minutes from the first message", async () => {
  await send(8, START + 29 * 60_000);
  localStorage.setItem(STAR_PROMPT_FIRST_SENT_KEY, String(START));
  expect(prompt()).toBeNull();
  await send(1);
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
});

it("asks after the sixth message and never again once dismissed", async () => {
  await send(1, START);
  await send(4);
  expect(prompt()).toBeNull();
  await send(1);
  // The toaster mounts toasts on its own timers.
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
  const link = prompt()?.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://github.com/elie222/rakazo");

  const notNow = [...(prompt()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Not now",
  );
  await act(async () => notNow?.click());
  expect(localStorage.getItem(STAR_PROMPT_DISMISSED_KEY)).toBe("1");
  await vi.waitFor(() => expect(prompt()).toBeNull());

  resetStarPromptSessionForTests();
  const count = localStorage.getItem(STAR_PROMPT_SENT_KEY);
  await send(3);
  expect(localStorage.getItem(STAR_PROMPT_SENT_KEY)).toBe(count);
});

it("asks at most once per session", async () => {
  await send(1, START);
  await send(5);
  const count = localStorage.getItem(STAR_PROMPT_SENT_KEY);
  await send(2);
  expect(localStorage.getItem(STAR_PROMPT_SENT_KEY)).toBe(count);
});
