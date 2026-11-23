// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { LinkFavicons } from "./markdown";
import { LinkFaviconsContext, LinkFaviconsPausedContext, useLinkFavicons } from "./markdown";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const OTHER_ICON = "data:image/png;base64,R0lGODlh";

function Probe({
  hrefs,
  seen,
}: {
  hrefs: readonly string[];
  seen: { current: ReadonlyMap<string, string> };
}) {
  seen.current = useLinkFavicons(hrefs);
  return null;
}

async function mountFavicons(
  hrefs: readonly string[],
  favicons: LinkFavicons,
  { paused = false }: { paused?: boolean } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const seen = { current: new Map() as ReadonlyMap<string, string> };
  const tree = (nextPaused: boolean): ReactNode => (
    <LinkFaviconsContext.Provider value={favicons}>
      <LinkFaviconsPausedContext.Provider value={nextPaused}>
        <Probe hrefs={hrefs} seen={seen} />
      </LinkFaviconsPausedContext.Provider>
    </LinkFaviconsContext.Provider>
  );
  await act(async () => {
    root.render(tree(paused));
  });
  return {
    icons: () => Object.fromEntries(seen.current),
    async resume() {
      await act(async () => {
        root.render(tree(false));
      });
    },
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe("useLinkFavicons", () => {
  it("asks once per site and gives every link to it that site's icon", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async (origin) => ({
      icon: origin === "https://many-a.example.test" ? ICON : OTHER_ICON,
    }));
    const view = await mountFavicons(
      [
        "https://many-a.example.test/one",
        "https://many-a.example.test/two",
        "https://many-b.example.test/",
        "mailto:someone@example.test",
        "/docs",
      ],
      { load },
    );
    await vi.waitFor(() => {
      expect(view.icons()).toEqual({
        "https://many-a.example.test/one": ICON,
        "https://many-a.example.test/two": ICON,
        "https://many-b.example.test/": OTHER_ICON,
      });
    });
    expect(load.mock.calls.map(([origin]) => origin).sort()).toEqual([
      "https://many-a.example.test",
      "https://many-b.example.test",
    ]);
    await view.cleanup();
  });

  it("leaves out a site the API has no icon for", async () => {
    const view = await mountFavicons(["https://none.example.test/a"], {
      load: async () => ({ icon: null }),
    });
    expect(view.icons()).toEqual({});
    await view.cleanup();
  });

  it("asks for nothing while paused, then asks once resumed", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: ICON }));
    const view = await mountFavicons(["https://paused.example.test/x"], { load }, { paused: true });
    expect(load).not.toHaveBeenCalled();
    expect(view.icons()).toEqual({});
    await view.resume();
    await vi.waitFor(() => {
      expect(view.icons()).toEqual({ "https://paused.example.test/x": ICON });
    });
    expect(load).toHaveBeenCalledTimes(1);
    await view.cleanup();
  });

  it("does not ask again right away after a failed lookup, but does after a while", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async () => {
      throw new Error("Not found");
    });
    const hrefs = ["https://failed.example.test/a", "https://failed.example.test/b"];
    const first = await mountFavicons(hrefs, { load });
    expect(first.icons()).toEqual({});
    await first.cleanup();
    const second = await mountFavicons(hrefs, { load });
    expect(load).toHaveBeenCalledTimes(1);
    await second.cleanup();

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    try {
      load.mockResolvedValue({ icon: ICON });
      const third = await mountFavicons(hrefs, { load });
      await vi.waitFor(() => {
        expect(third.icons()).toEqual({
          "https://failed.example.test/a": ICON,
          "https://failed.example.test/b": ICON,
        });
      });
      expect(load).toHaveBeenCalledTimes(2);
      await third.cleanup();
    } finally {
      clock.mockRestore();
    }
  });

  it("asks a busy server again a little later, and stops once no link to it is shown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi
        .fn<LinkFavicons["load"]>()
        .mockResolvedValueOnce({ icon: null, retry: true })
        .mockResolvedValue({ icon: ICON });
      const view = await mountFavicons(["https://busy.example.test/a"], { load });
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(view.icons()).toEqual({ "https://busy.example.test/a": ICON });
      await view.cleanup();

      const busy = vi.fn<LinkFavicons["load"]>(async () => ({ icon: null, retry: true }));
      const gone = await mountFavicons(["https://busy-gone.example.test/a"], { load: busy });
      await gone.cleanup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(busy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers an answer for links drawn later", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: ICON }));
    const first = await mountFavicons(["https://shared.example.test/a"], { load });
    await vi.waitFor(() =>
      expect(first.icons()).toEqual({ "https://shared.example.test/a": ICON }),
    );
    const second = await mountFavicons(["https://shared.example.test/b"], { load });
    expect(second.icons()).toEqual({ "https://shared.example.test/b": ICON });
    expect(load).toHaveBeenCalledTimes(1);
    await first.cleanup();
    await second.cleanup();
  });
});
