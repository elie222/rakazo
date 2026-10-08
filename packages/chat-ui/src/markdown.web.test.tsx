// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LinkFavicons } from "./markdown.web";
import {
  ChatMarkdown,
  LinkFaviconsContext,
  LinkifiedText,
  RemoteImagesContext,
} from "./markdown.web";

describe("web markdown remote images", () => {
  it("loads a remote image in place only after the reader asks", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown = "![chart](https://images.example.test/tap.png)";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("chartimages.example.test");
    await act(async () => {
      button?.click();
    });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://images.example.test/tap.png");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain(
      'src="https://images.example.test/tap.png"',
    );
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (src: string) => {
      root.render(<ChatMarkdown>{`![chart](${src})`}</ChatMarkdown>);
    };
    await act(async () => {
      render("https://images.example.test/first.png");
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://images.example.test/first.png",
    );

    await act(async () => {
      render("https://images.example.test/second.png");
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("button")?.textContent).toContain("images.example.test");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads a linked image from a placeholder that is not inside the anchor", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown =
      "See [![build](https://badge.example.test/tap-linked.svg)](https://ci.example.test/tap-linked) now";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("tap-linked.svg");
    expect(container.querySelector("a button")).toBeNull();

    const button = container.querySelector("button");
    const link = container.querySelector("a");
    expect(button?.closest("a")).toBeNull();
    expect(button?.textContent).toContain("build");
    expect(button?.textContent).toContain("badge.example.test");
    expect(link?.getAttribute("href")).toBe("https://ci.example.test/tap-linked");
    expect(link?.textContent).toBe("ci.example.test");
    expect(container.querySelectorAll("a")).toHaveLength(1);

    await act(async () => {
      button?.click();
    });
    const image = container.querySelector("a img");
    expect(image?.getAttribute("src")).toBe("https://badge.example.test/tap-linked.svg");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("a button")).toBeNull();
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps an image inside a rejected link as text when automatic loading is on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>Open</span>");
    expect(html).toContain("<span>File</span>");
  });
});

const ICON = "data:image/png;base64,iVBORw0KGgo=";

async function renderLinks(
  markdown: string,
  favicons: LinkFavicons,
  options: { streaming?: boolean } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (streaming = options.streaming, source = favicons) => {
    await act(async () => {
      root.render(
        <LinkFaviconsContext.Provider value={source}>
          <ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>
        </LinkFaviconsContext.Provider>,
      );
    });
  };
  await render();
  return {
    container,
    render,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web markdown website links", () => {
  it("isolates cached misses and pending answers when the API endpoint changes", async () => {
    let resolveOld!: (answer: { icon: string | null }) => void;
    const oldLoad = vi.fn<LinkFavicons["load"]>((origin) =>
      origin.includes("pending")
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ icon: null }),
    );
    const newLoad = vi.fn<LinkFavicons["load"]>(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "[Miss](https://scope-miss.example.test/) [Pending](https://scope-pending.example.test/)",
      { endpoint: "https://old-api.example.test", load: oldLoad },
    );
    expect(view.container.querySelectorAll("a img")).toHaveLength(0);
    await view.render(false, { endpoint: "https://new-api.example.test", load: newLoad });
    expect(newLoad).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll("a img")).toHaveLength(2);
    await act(async () => {
      resolveOld({ icon: null });
    });
    expect(view.container.querySelectorAll("a img")).toHaveLength(2);
    await view.cleanup();
  });

  it("draws the API's site icon in a hidden tile before the author's label", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "Traffic plunges. [Post](https://icon-a.example.test/p/1) and [odds](https://icon-a.example.test/o)",
      { load },
    );
    const links = view.container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    const [post] = links;
    expect(post?.getAttribute("href")).toBe("https://icon-a.example.test/p/1");
    expect(post?.getAttribute("class")).toBe("rk-chat-link");
    const tile = post?.querySelector(".rk-chat-link-tile");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.classList.contains("rk-chat-link-tile-icon")).toBe(true);
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe(ICON);
    expect(tile?.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(post?.querySelector(".rk-chat-link-label")?.textContent).toBe("Post");
    // The link reads as its label alone: the tile has no text and is hidden.
    expect(post?.textContent).toBe("Post");
    // One lookup per origin, by origin only: the path never leaves the client.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("https://icon-a.example.test");
    await view.cleanup();
  });

  it("shortens a bare URL to host and path", async () => {
    const view = await renderLinks(
      "See https://www.icon-b.example.test/status/123?s=20 and <https://icon-b.example.test/>",
      { load: async () => ({ icon: null }) },
    );
    const labels = [...view.container.querySelectorAll(".rk-chat-link-label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["icon-b.example.test/status/123", "icon-b.example.test"]);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.icon-b.example.test/status/123?s=20",
    );
    await view.cleanup();
  });

  it("shows the globe until an icon arrives, and when there is none", async () => {
    let resolve: (answer: { icon: string | null }) => void = () => undefined;
    const view = await renderLinks("[Docs](https://icon-c.example.test/docs)", {
      load: () => new Promise((done) => (resolve = done)),
    });
    const tile = () => view.container.querySelector(".rk-chat-link-tile");
    expect(tile()?.querySelector("svg")).not.toBeNull();
    expect(tile()?.classList.contains("rk-chat-link-tile-icon")).toBe(false);
    await act(async () => {
      resolve({ icon: null });
    });
    expect(tile()?.querySelector("img")).toBeNull();
    expect(tile()?.querySelector("svg")).not.toBeNull();
    await view.cleanup();
  });

  it("falls back to the globe when the icon fails or is a 1×1 pixel", async () => {
    const view = await renderLinks(
      "[A](https://icon-d.example.test/) [B](https://icon-e.example.test/)",
      { load: async () => ({ icon: ICON }) },
    );
    const [first, second] = view.container.querySelectorAll<HTMLImageElement>("a img");
    await act(async () => {
      first?.dispatchEvent(new Event("error"));
      Object.defineProperty(second, "naturalWidth", { value: 1 });
      Object.defineProperty(second, "naturalHeight", { value: 1 });
      second?.dispatchEvent(new Event("load"));
    });
    expect(view.container.querySelectorAll("a img")).toHaveLength(0);
    expect(view.container.querySelectorAll("a .rk-chat-link-tile svg")).toHaveLength(2);
    await view.cleanup();
  });

  it("shows the globe after a failed lookup and asks again only after a while", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async () => {
      throw new Error("Not found");
    });
    const markdown = "[A](https://icon-j.example.test/) [B](https://icon-j.example.test/b)";
    const first = await renderLinks(markdown, { load });
    expect(first.container.querySelectorAll(".rk-chat-link-tile svg")).toHaveLength(2);
    await first.cleanup();
    const second = await renderLinks(markdown, { load });
    expect(second.container.querySelectorAll(".rk-chat-link-tile svg")).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    await second.cleanup();

    // After an outage, a later mount tries once more.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    load.mockResolvedValue({ icon: ICON });
    const third = await renderLinks(markdown, { load });
    expect(load).toHaveBeenCalledTimes(2);
    expect(third.container.querySelectorAll(".rk-chat-link-tile img")).toHaveLength(2);
    await third.cleanup();
    clock.mockRestore();
  });

  it("asks a busy server again a little later instead of remembering a miss", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi
        .fn<LinkFavicons["load"]>()
        .mockResolvedValueOnce({ icon: null, retry: true })
        .mockResolvedValue({ icon: ICON });
      const view = await renderLinks("[Busy](https://icon-l.example.test/)", { load });
      expect(view.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector(".rk-chat-link-tile img")?.getAttribute("src")).toBe(
        ICON,
      );
      await view.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking a busy server once no link to that site is on screen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: null, retry: true }));
      const view = await renderLinks(
        "[A](https://icon-n.example.test/) [B](https://icon-n.example.test/b)",
        { load },
      );
      expect(load).toHaveBeenCalledTimes(1);
      await view.cleanup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(load).toHaveBeenCalledTimes(1);

      // Nothing was remembered, so the next link to that site asks again.
      load.mockResolvedValue({ icon: ICON });
      const again = await renderLinks("[A](https://icon-n.example.test/)", { load });
      expect(load).toHaveBeenCalledTimes(2);
      expect(again.container.querySelector(".rk-chat-link-tile img")).not.toBeNull();
      await again.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a server that stays busy, then waits like any failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: null, retry: true }));
      const view = await renderLinks("[Busy](https://icon-m.example.test/)", { load });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(load).toHaveBeenCalledTimes(3);
      await view.cleanup();
      const again = await renderLinks("[Busy](https://icon-m.example.test/)", { load });
      expect(load).toHaveBeenCalledTimes(3);
      expect(again.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
      await again.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for no icon while a reply streams, then loads it", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "Partial https://icon-f.example.test/x",
      { load },
      {
        streaming: true,
      },
    );
    expect(view.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await view.render(false);
    expect(load).toHaveBeenCalledWith("https://icon-f.example.test");
    expect(view.container.querySelector(".rk-chat-link-tile img")).not.toBeNull();
    await view.cleanup();
  });

  it("gives no tile to links that are not websites", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      [
        "[mail](mailto:someone@example.com)",
        "[call](tel:+15555550100)",
        "[docs](/docs)",
        "[top](#top)",
        "[bad](javascript:alert(1))",
        "`https://icon-g.example.test/in-code`",
        "[![badge](data:image/png;base64,iVBORw0KGgo=)](https://icon-g.example.test/badge)",
        "[![build](https://badge.example.test/b.svg)](https://icon-g.example.test/ci)",
      ].join("\n\n"),
      { load },
    );
    expect(view.container.querySelector(".rk-chat-link-tile")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("isolates a label so its direction characters stay inside the link", async () => {
    const view = await renderLinks(
      "See [\u202Eevil](https://icon-k.example.test/) then [next](https://icon-k.example.test/n)",
      { load: async () => ({ icon: null }) },
    );
    const labels = view.container.querySelectorAll("a > .rk-chat-link-label");
    expect([...labels].map((label) => label.tagName)).toEqual(["BDI", "BDI"]);
    expect(labels[0]?.textContent).toBe("\u202Eevil");
    await view.cleanup();
  });

  it("keeps formatting inside a labelled link", async () => {
    const view = await renderLinks("[**Bold** label](https://icon-h.example.test/)", {
      load: async () => ({ icon: null }),
    });
    expect(view.container.querySelector("a .rk-chat-link-label strong")?.textContent).toBe("Bold");
    await view.cleanup();
  });

  it("draws the tile in user messages too", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <LinkFaviconsContext.Provider value={{ load: async () => ({ icon: ICON }) }}>
          <LinkifiedText>
            {"look https://icon-i.example.test/a/b/ or mail me@example.com"}
          </LinkifiedText>
        </LinkFaviconsContext.Provider>,
      );
    });
    const links = container.querySelectorAll("a");
    expect(links[0]?.querySelector(".rk-chat-link-tile img")?.getAttribute("src")).toBe(ICON);
    expect(links[0]?.textContent).toBe("icon-i.example.test/a/b");
    expect(links[1]?.getAttribute("href")).toBe("mailto:me@example.com");
    expect(links[1]?.querySelector(".rk-chat-link-tile")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

function buttonNamed(container: ParentNode, name: string) {
  return [...container.querySelectorAll<HTMLElement>("button")].find(
    (element) => element.textContent === name,
  );
}

async function render(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web external link confirmation", () => {
  it("asks before an external bot link and opens it only after confirmation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>{"See [Docs](https://example.test/docs?x=1)"}</ChatMarkdown>,
    );
    const link = view.container.querySelector("a");
    expect(link?.textContent).toBe("Docs");

    await act(async () => {
      link?.click();
    });
    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog?.textContent).toContain("Open external link?");
    expect(dialog?.textContent).toContain("https://example.test/docs?x=1");
    expect(dialog?.querySelector("strong")?.textContent).toBe("example.test");
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      buttonNamed(document, "Cancel")?.click();
    });
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();

    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    await act(async () => {
      buttonNamed(document, "Open")?.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://example.test/docs?x=1",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    await view.cleanup();
  });

  it("asks before a linked remote image destination", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>
        {
          "[![Quarterly chart](https://images.example.test/chart.png)](https://images.example.test/chart.png)"
        }
      </ChatMarkdown>,
    );
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog?.querySelector("strong")?.textContent).toBe("images.example.test");
    expect(dialog?.textContent).toContain("https://images.example.test/chart.png");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });

  it("opens in-app routes, mailto, and tel without asking", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>
        {"[home](/threads/1) [mail](mailto:user@example.test) [call](tel:+15551212)"}
      </ChatMarkdown>,
    );
    const links = [...view.container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/threads/1",
      "mailto:user@example.test",
      "tel:+15551212",
    ]);
    for (const link of links) {
      link.addEventListener("click", (event) => event.preventDefault());
      await act(async () => {
        link.click();
      });
    }
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });

  it("asks before a link in plain user text", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(<LinkifiedText>{"https://example.test/docs"}</LinkifiedText>);
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    expect(document.querySelector("[role='alertdialog'] strong")?.textContent).toBe("example.test");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });
});
