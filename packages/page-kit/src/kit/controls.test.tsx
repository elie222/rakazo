// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Checkbox,
  CopyButton,
  copyText,
  Input,
  LinkButton,
  ReplyButton,
  replyText,
  Select,
  TextLink,
  Toggle,
} from "./controls.js";
import { Segmented } from "./data.js";
import { Section } from "./layout.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let posted: unknown[];
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
});
afterEach(() => {
  host.remove();
  document.documentElement.removeAttribute("data-reply");
  vi.restoreAllMocks();
});

function render(element: ReactElement) {
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}
const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
const click = (element: Element | null) => act(() => (element as HTMLElement).click());

describe("controls", () => {
  it("runs a button's action, draws nothing without a label and ignores a disabled press", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button label="Save" variant="primary" onClick={onClick} />
        <Button label="" onClick={onClick} />
        <Button label="Locked" disabled onClick={onClick} />
      </>,
    );
    const buttons = host.querySelectorAll("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["Save", "Locked"]);
    expect(buttons[0]!.dataset.variant).toBe("primary");
    click(buttons[0]!);
    click(buttons[1]!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("offers a reply only where the host has a composer, collapsed and at most 300 characters", () => {
    render(<ReplyButton label="Ask" reply={"  Summarise   the\n tickets "} />);
    expect(q<HTMLButtonElement>("button")!.disabled).toBe(true);

    document.documentElement.setAttribute("data-reply", "");
    host.remove();
    host = document.body.appendChild(document.createElement("div"));
    render(
      <>
        <ReplyButton label="Ask" reply={"  Summarise   the\n tickets "} />
        <ReplyButton label="Use my label" />
        <ReplyButton label="Too long" reply={"x".repeat(301)} />
      </>,
    );
    const [ask, label, long] = host.querySelectorAll("button");
    expect(long!.disabled).toBe(true);
    click(ask!);
    click(label!);
    expect(posted).toEqual([
      { type: "rakazo-page:reply", text: "Summarise the tickets" },
      { type: "rakazo-page:reply", text: "Use my label" },
    ]);
    expect(replyText("x".repeat(300))).toHaveLength(300);
    expect(replyText("   ")).toBeUndefined();
  });

  it("copies through the host, never the page's own clipboard, and shows the text when it cannot", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const answer = (data: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data }));
        await Promise.resolve();
      });
    render(
      <>
        <CopyButton label="Copy yes" text="yes" />
        <CopyButton label="Copy no" text="no" copiedLabel="Done" />
        <CopyButton label="Copy silent" text="silent" />
      </>,
    );
    const [yes, no, silent] = host.querySelectorAll("button");
    await act(async () => yes!.click());
    const asked = posted as { type: string; id: string; text: string }[];
    expect(asked).toEqual([{ type: "rakazo-page:copy", id: expect.any(String), text: "yes" }]);
    // Another copy's answer, or a forged one for no request, changes nothing.
    await answer({ type: "rakazo-page:copied", id: "other", ok: true });
    expect(yes!.textContent).toBe("Copy yes");
    await answer({ type: "rakazo-page:copied", id: asked[0]!.id, ok: true });
    expect(yes!.textContent).toBe("Copied");
    await act(async () => vi.advanceTimersByTime(1600));
    expect(yes!.textContent).toBe("Copy yes");

    await act(async () => no!.click());
    await answer({ type: "rakazo-page:copied", id: asked[1]!.id, ok: false });
    expect(no!.textContent).toBe("Copy no");
    expect(q(".rk-copy-fallback")!.textContent).toBe("no");

    // A host that never answers counts as blocked, so the reader can still select the text.
    await act(async () => silent!.click());
    await act(async () => vi.advanceTimersByTime(2000));
    expect([...host.querySelectorAll(".rk-copy-fallback")].map((node) => node.textContent)).toEqual(
      ["no", "silent"],
    );
    expect(await copyText("x".repeat(20_001))).toBe(false);
    expect(posted).toHaveLength(3);
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([true, false])("ignores an older copy result after a newer result (%s)", async (ok) => {
    const view = render(<CopyButton label="Copy" text="value" />);
    click(q("button"));
    click(q("button"));
    const requests = posted as { id: string }[];
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: requests[1]!.id, ok },
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: requests[0]!.id, ok: !ok },
        }),
      );
    });
    expect(q("button")!.textContent).toBe(ok ? "Copied" : "Copy");
    expect(q(".rk-copy-fallback")?.textContent ?? null).toBe(ok ? null : "value");
    view.unmount();
  });

  it.each([true, false])("ignores a pending copy after its content changes (%s)", async (ok) => {
    const view = render(<CopyButton label="Copy" text="old" />);
    click(q("button"));
    const request = posted[0] as { id: string };
    view.rerender(<CopyButton label="Copy" text="new" />);
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: request.id, ok },
        }),
      );
    });
    expect(q("button")!.textContent).toBe("Copy");
    expect(q(".rk-copy-fallback")).toBeNull();
    view.unmount();
  });

  it.each([true, false])(
    "clears settled copy feedback when its content changes (%s)",
    async (ok) => {
      const view = render(<CopyButton label="Copy" text="old" />);
      click(q("button"));
      const request = posted[0] as { id: string };
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "rakazo-page:copied", id: request.id, ok },
          }),
        );
      });
      view.rerender(<CopyButton label="Copy" text="new" />);
      expect(q("button")!.textContent).toBe("Copy");
      expect(q(".rk-copy-fallback")).toBeNull();
      view.unmount();
    },
  );

  it.each([true, false])("never commits old feedback for changed text (%s)", async (ok) => {
    const committed: { button: string | null; fallback: string | null }[] = [];
    function Probe({ value }: { value: string }) {
      useLayoutEffect(() => {
        committed.push({
          button: q("button")?.textContent ?? null,
          fallback: q(".rk-copy-fallback")?.textContent ?? null,
        });
      }, [value]);
      return <CopyButton label="Copy" text={value} />;
    }
    const view = render(<Probe value="old" />);
    click(q("button"));
    const request = posted[0] as { id: string };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: request.id, ok },
        }),
      );
    });
    view.rerender(<Probe value="new" />);
    expect(committed[1]).toEqual({ button: "Copy", fallback: null });
    view.unmount();
  });

  it("ignores an older response while the newest copy is still pending", async () => {
    const view = render(<CopyButton label="Copy" text="value" />);
    click(q("button"));
    click(q("button"));
    const requests = posted as { id: string }[];
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: requests[0]!.id, ok: false },
        }),
      );
    });
    expect(q("button")!.textContent).toBe("Copy");
    expect(q(".rk-copy-fallback")).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "rakazo-page:copied", id: requests[1]!.id, ok: true },
        }),
      );
    });
    expect(q("button")!.textContent).toBe("Copied");
    view.unmount();
  });

  it("ignores an older timeout and gives a repeated success its own confirmation interval", async () => {
    vi.useFakeTimers();
    const view = render(<CopyButton label="Copy" text="value" />);
    try {
      click(q("button"));
      await act(async () => vi.advanceTimersByTime(1000));
      click(q("button"));
      const requests = posted as { id: string }[];
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "rakazo-page:copied", id: requests[1]!.id, ok: true },
          }),
        );
      });
      await act(async () => vi.advanceTimersByTime(1100));
      expect(q("button")!.textContent).toBe("Copied");
      expect(q(".rk-copy-fallback")).toBeNull();
      click(q("button"));
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "rakazo-page:copied", id: requests[2]!.id, ok: true },
          }),
        );
      });
      await act(async () => vi.advanceTimersByTime(1599));
      expect(q("button")!.textContent).toBe("Copied");
      await act(async () => vi.advanceTimersByTime(1));
      expect(q("button")!.textContent).toBe("Copy");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("asks the host to open web and mail links and leaves other addresses as text", () => {
    render(
      <>
        <LinkButton label="Open" href="https://example.com/a" />
        <LinkButton label="Docs" href="mailto:a@example.com" variant="text" />
        <LinkButton label="Bad" href="data:text/html,hi" />
        <TextLink href="https://example.com/b">source</TextLink>
        <TextLink href="file:///etc/passwd">plain</TextLink>
      </>,
    );
    const links = host.querySelectorAll("a");
    expect([...links].map((link) => link.textContent)).toEqual(["Open", "Docs", "source"]);
    expect(host.textContent).toContain("Bad");
    expect(host.textContent).toContain("plain");
    for (const link of links) click(link);
    expect(posted).toEqual([
      { type: "rakazo-page:open-link", url: "https://example.com/a" },
      { type: "rakazo-page:open-link", url: "mailto:a@example.com" },
      { type: "rakazo-page:open-link", url: "https://example.com/b" },
    ]);
  });

  it("shows a select's placeholder until a listed value is chosen and reports the choice", () => {
    const onChange = vi.fn();
    const view = render(
      <Select
        label="Region"
        value=""
        onChange={onChange}
        placeholder="Choose a region"
        options={[{ value: "eu", label: "Europe" }, "Asia"]}
      />,
    );
    const select = q<HTMLSelectElement>("select")!;
    expect(q<HTMLLabelElement>("label")!.htmlFor).toBe(select.id);
    expect(select.selectedOptions[0]!.textContent).toBe("Choose a region");
    act(() => {
      select.value = "Asia";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Asia");
    view.rerender(<Select value="eu" options={[{ value: "eu", label: "Europe" }]} disabled />);
    expect(q<HTMLSelectElement>("select")!.selectedOptions[0]!.textContent).toBe("Europe");
    expect(q<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(host.textContent).not.toContain("Choose a region");
  });

  it("offers the decimal pad only when a number can't go negative", () => {
    const view = render(<Input value={1} type="number" min={0} />);
    expect(q<HTMLInputElement>("input")!.inputMode).toBe("decimal");
    expect(q<HTMLInputElement>("input")!.min).toBe("0");
    view.rerender(<Input value={1} type="number" min={-5} />);
    expect(q<HTMLInputElement>("input")!.inputMode).toBe("");
    view.rerender(<Input value={1} type="number" />);
    expect(q<HTMLInputElement>("input")!.inputMode).toBe("");
    // Pages are written as plain JavaScript, so a min given as text still counts.
    view.rerender(<Input value={1} type="number" min={"0" as unknown as number} />);
    expect(q<HTMLInputElement>("input")!.inputMode).toBe("decimal");
    view.rerender(<Input value="a" type="text" min={0} />);
    expect(q<HTMLInputElement>("input")!.inputMode).toBe("");
  });

  it("reports typed text and makes number inputs numeric", () => {
    const onChange = vi.fn();
    render(<Input label="Seats" value={12} type="number" onChange={onChange} />);
    const input = q<HTMLInputElement>("input")!;
    expect(input.value).toBe("12");
    expect(input.type).toBe("number");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "13");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("13");
  });

  it("flips a toggle through the page's state and shows a checkbox the reader cannot change", () => {
    const onChange = vi.fn();
    render(
      <>
        <Toggle label="Only active" value={false} onChange={onChange} />
        <Toggle label="Archived" value={true} onChange={onChange} disabled />
        <Checkbox label="Paid" value={true} />
      </>,
    );
    const [on, off] = host.querySelectorAll<HTMLInputElement>('[role="switch"]');
    expect(on!.checked).toBe(false);
    click(on!);
    expect(onChange).toHaveBeenCalledWith(true);
    click(off!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const box = q<HTMLInputElement>('.rk-checkbox input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-readonly")).toBe("true");
  });

  it("shows segment counts and keeps the chosen segment when there are too many to list", () => {
    const onChange = vi.fn();
    const many = Array.from({ length: 250 }, (_, index) => `o${index}`);
    const view = render(
      <Segmented
        value="open"
        onChange={onChange}
        options={[{ value: "open", label: "Open", count: 12 }, "All"]}
      />,
    );
    expect(q(".rk-segment-count")!.textContent).toBe("12");
    click(host.querySelectorAll("button")[1]!);
    expect(onChange).toHaveBeenCalledWith("All");
    view.rerender(<Segmented value="o240" options={many} />);
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(200);
    expect(q('[aria-pressed="true"]')!.textContent).toBe("o240");
  });

  it("presses the segment for a numeric value and still reports the choice as a string", () => {
    const onChange = vi.fn();
    render(<Segmented options={[1, 2, 3]} value={2} onChange={onChange} />);
    expect(q('[aria-pressed="true"]')!.textContent).toBe("2");
    expect(host.querySelectorAll('[aria-pressed="false"]')).toHaveLength(2);
    click(host.querySelectorAll("button")[2]!);
    expect(onChange).toHaveBeenCalledWith("3");
  });

  it("presses the object option whose numeric value is chosen", () => {
    render(
      <Segmented
        options={[
          { value: 7, label: "Week" },
          { value: 30, label: "Month" },
        ]}
        value={30}
      />,
    );
    expect(q('[aria-pressed="true"]')!.textContent).toBe("Month");
  });

  it("keeps a numeric chosen segment when there are too many to list", () => {
    const many = Array.from({ length: 250 }, (_, index) => index);
    render(<Segmented value={240} options={many} />);
    expect(host.querySelectorAll("button")).toHaveLength(200);
    expect(q('[aria-pressed="true"]')!.textContent).toBe("240");
  });

  it("keeps string values pressed and reports the clicked value as a string", () => {
    const onChange = vi.fn();
    render(<Segmented options={["a", "b"]} value="a" onChange={onChange} />);
    expect(q('[aria-pressed="true"]')!.textContent).toBe("a");
    click(host.querySelectorAll("button")[1]!);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("shows a section's content again once the value that broke it is replaced", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Period() {
      const [period, setPeriod] = useState("bad");
      return (
        <Section
          heading="Revenue"
          actions={<Segmented options={["bad", "good"]} value={period} onChange={setPeriod} />}
        >
          {period === "bad" ? <Broken /> : <p>Good numbers</p>}
        </Section>
      );
    }
    render(<Period />);
    expect(q(".rk-error")).not.toBeNull();
    click(host.querySelectorAll("button")[1]!);
    expect(q(".rk-error")).toBeNull();
    expect(host.textContent).toContain("Good numbers");
    expect(consoleError).toHaveBeenCalled();
  });

  it("tries content that keeps throwing once per re-render, not in a loop", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    function CountingBroken(): never {
      attempts += 1;
      throw new Error("bad period");
    }
    const page = () => (
      <Section heading="Revenue">
        <CountingBroken />
      </Section>
    );
    const view = render(page());
    expect(q(".rk-error")).not.toBeNull();
    const afterFirst = attempts;
    for (let i = 0; i < 3; i++) {
      const before = attempts;
      view.rerender(page());
      // React retries a throwing render once itself, so each pass is a small fixed number.
      expect(attempts - before).toBeLessThanOrEqual(afterFirst);
      expect(attempts - before).toBeGreaterThan(0);
    }
    const settled = attempts;
    expect(q(".rk-error")!.textContent).toContain("bad period");
    expect(attempts).toBe(settled);
  });
});

function Broken(): never {
  throw new Error("bad period");
}
