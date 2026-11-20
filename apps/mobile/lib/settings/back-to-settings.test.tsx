// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBackToSettings } from "./back-to-settings";

type Removed = (event: { data: { action: { type: string } } }) => void;

const page = vi.hoisted(() => ({
  params: {} as { from?: string },
  push: vi.fn(),
  removed: null as Removed | null,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-router", () => {
  const router = { push: page.push };
  const navigation = {
    addListener: (_name: string, listener: Removed) => {
      page.removed = listener;
      return () => {
        page.removed = null;
      };
    },
  };
  return {
    useLocalSearchParams: () => page.params,
    useNavigation: () => navigation,
    useRouter: () => router,
  };
});

let root: Root | null = null;

function Page() {
  useBackToSettings();
  return null;
}

async function open(params: { from?: string }) {
  page.params = params;
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Page />));
}

// As the navigator does: the page unmounts, then the event fires before the next microtask.
async function leave(action: string) {
  const listener = page.removed;
  await act(async () => root?.unmount());
  root = null;
  listener?.({ data: { action: { type: action } } });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page.push.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

it("reopens settings when a page settings opened goes back", async () => {
  await open({ from: "settings" });
  await leave("POP");
  expect(page.push).toHaveBeenCalledWith("/account");
});

it("stays closed when the page is replaced or dismissed with everything, or was not opened from settings", async () => {
  await open({ from: "settings" });
  await leave("REPLACE");
  // Leaving a Space dismisses every page on the way Home.
  await open({ from: "settings" });
  await leave("POP_TO_TOP");
  await open({});
  await leave("GO_BACK");
  expect(page.push).not.toHaveBeenCalled();
});
