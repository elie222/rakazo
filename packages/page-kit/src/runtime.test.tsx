// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { pageViewerCode } from "./compile.js";
import { checkPageSource } from "./validate.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "scrollingElement");
});

function runInlineScripts() {
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) new Function(node.text)();
    }
    append(...nodes);
  });
}

it("mounts a page and reports its height where the browser has no ResizeObserver", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", undefined);
  const posted: unknown[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  await import("./runtime.js");
  const code = pageViewerCode(
    `const App = () => (\n  <Page title="Hello">\n    <Text>Drawn</Text>\n  </Page>\n);\nexport default App;\n`,
  );
  const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } }).RakazoPage;
  await act(async () => {
    page.mount({ code, theme: "light", errorTitle: "This page couldn't be shown." });
    await flush();
  });
  // jsdom runs no inline scripts, so the page's own code shows its error panel; what matters is
  // that mounting got that far instead of throwing before anything drew.
  expect(document.body.textContent).toContain("This page couldn't be shown.");
  await vi.waitFor(() =>
    expect(posted).toContainEqual(expect.objectContaining({ type: "rakazo-page:height" })),
  );
});

it("reports overflow changes even when the body box stays the same size", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: () => void) {}
      observe() {
        observers.push(this.onResize);
        this.onResize();
      }
    },
  );
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((report) => frames.push(report));
  const posted = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  document.body.replaceChildren();
  // jsdom has no layout. The body and the viewport can have different scroll ranges.
  const viewport = document.documentElement;
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: viewport });
  const readScrollHeight = vi.spyOn(viewport, "scrollHeight", "get").mockReturnValue(400);
  const readHeight = vi.spyOn(document.body, "scrollHeight", "get").mockReturnValue(121);
  await import("./runtime.js");
  runInlineScripts();
  await act(async () => {
    window.RakazoPage!.mount({
      code: pageViewerCode(`
        export default function Report() {
          return <div style={{ position: "relative", height: 100 }}>
            <span style={{ position: "absolute", top: 24 }}>Last line</span>
          </div>;
        }
      `),
      theme: "light",
      errorTitle: "Page error",
    });
    await flush();
  });
  for (const report of frames.splice(0)) report(0);
  expect(posted).toHaveBeenCalledWith(
    { type: "rakazo-page:height", height: 121, scrollHeight: 400 },
    "*",
  );
  readHeight.mockClear();
  posted.mockClear();

  const lastLine = document.querySelector("span")!;
  lastLine.style.top = "880px";
  readScrollHeight.mockReturnValue(903);
  await flush();
  lastLine.style.color = "red";
  await flush();
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  expect(readHeight).toHaveBeenCalledTimes(1);
  const dimensions = { type: "rakazo-page:height", height: 121, scrollHeight: 903 };
  expect(posted).toHaveBeenCalledExactlyOnceWith(dimensions, "*");

  lastLine.style.color = "blue";
  await flush();
  frames.shift()!(0);
  expect(posted).toHaveBeenCalledTimes(1);
  expect(frames).toHaveLength(0);

  // The interactive viewer uses the report to update the page's print width as well.
  vi.stubGlobal("innerWidth", window.innerWidth + 100);
  observers[0]!();
  frames.shift()!(0);
  expect(posted).toHaveBeenCalledTimes(2);
  expect(posted).toHaveBeenLastCalledWith(dimensions, "*");
});

it("runs a saved page that declares its own component under a kit component's name", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await import("./runtime.js");
  // jsdom runs no inline scripts, so run the page's script the way a browser would.
  runInlineScripts();
  const checked = checkPageSource(
    "const Steps = () => <p>Own steps</p>;\nconst App = () => <Steps />;\nexport default App;\n",
  );
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  document.body.replaceChildren();
  const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } }).RakazoPage;
  await act(async () => {
    page.mount({ code: checked.code, theme: "light", errorTitle: "This page couldn't be shown." });
    await flush();
  });
  expect(document.body.textContent).toBe("Own steps");
});

it("reports repeated headings separately and finds a pending anchor after a reveal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await import("./runtime.js");
  runInlineScripts();
  const measure = vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (
    this: Element,
  ) {
    return { length: this.closest(".collapsed") ? 0 : 1 } as DOMRectList;
  });
  const scrolled = vi.fn();
  const posted = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  document.body.replaceChildren();
  await act(async () => {
    window.RakazoPage!.mount({
      code: pageViewerCode(`
        export default function Report() {
          return <><h2>Timeline</h2><div className="collapsed"><h2>Timeline</h2></div></>;
        }
      `),
      theme: "light",
      errorTitle: "Page error",
      review: true,
      reviewAnchor: "Timeline",
      reviewAnchorOccurrence: 1,
    });
    await flush();
  });
  const [first, second] = document.querySelectorAll("h2");
  first!.scrollIntoView = () => scrolled(first);
  second!.scrollIntoView = () => scrolled(second);
  const firstAnchor = { section: "Timeline", sectionOccurrence: 0 };
  expect(posted).toHaveBeenCalledWith(
    { type: "rakazo-page:sections", sections: ["Timeline"], anchors: [firstAnchor] },
    "*",
  );
  expect(scrolled).not.toHaveBeenCalled();

  vi.useFakeTimers();
  measure.mockClear();
  const wrapper = second!.parentElement!;
  for (let frame = 0; frame < 5; frame++) {
    wrapper.style.opacity = String(frame / 4);
    await vi.advanceTimersByTimeAsync(16);
  }
  wrapper.classList.remove("collapsed");
  expect(measure).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(measure).toHaveBeenCalledTimes(2);
  expect(scrolled).toHaveBeenCalledExactlyOnceWith(second);
  expect(posted).toHaveBeenCalledWith(
    {
      type: "rakazo-page:sections",
      sections: ["Timeline", "Timeline"],
      anchors: [firstAnchor, { section: "Timeline", sectionOccurrence: 1 }],
    },
    "*",
  );
});
