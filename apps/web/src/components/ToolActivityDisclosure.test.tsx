// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The macro compiles away in the app build; tests run the source, so expand the
// plural by hand to assert the singular vs plural English forms.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, i) => `${text}${part}${values[i] ?? ""}`, ""),
}));
// A row's panel reads records the thread's events already delivered; nothing to fetch here.
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({ threads: { toolCalls: { queryOptions: () => ({}) } } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

/** The words a reader sees, with each element's text as its own word. */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

import { LIVE_TOOL_STEP_WINDOW } from "@rakazo/core";
import { clearToolCallRecords } from "../lib/tool-call-records";
import { replayToolCallRecords } from "../lib/tool-call-records.fixture";
import {
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "./ToolActivityDisclosure";

const MESSAGE = { threadId: "thread-1", runId: "run-1", createdAt: "2026-08-16T00:00:01.000Z" };

function markup(props: {
  live: boolean;
  stepCount: number;
  durationMs?: number;
  steps?: Array<{ label: string; count: number }>;
}) {
  return renderToStaticMarkup(
    <ToolActivityDisclosure
      live={props.live}
      stepCount={props.stepCount}
      durationMs={props.durationMs}
    >
      <ToolSteps steps={props.steps ?? [{ label: "Shell", count: props.stepCount }]} />
    </ToolActivityDisclosure>,
  );
}

/** Finished steps; while live, only the last one is still running. */
function stepsOf(n: number, live = false) {
  return Array.from({ length: n }, (_, i) => ({
    label: `step-${i}`,
    count: 1,
    ...(live && i === n - 1 ? {} : { outcome: "ok" as const }),
  }));
}

const OPEN_TRIGGER = /aria-expanded="true"/;

function mountCard() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (live: boolean, stepCount = 2) =>
    flushSync(() =>
      root.render(
        <ToolActivityDisclosure live={live} stepCount={stepCount}>
          <ToolSteps steps={stepsOf(stepCount)} />
        </ToolActivityDisclosure>,
      ),
    );
  const details = () => container.querySelector("button[aria-expanded]");
  const summary = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  return { render, details, summary, unmount: () => root.unmount() };
}

describe("ToolActivityDisclosure", () => {
  it("labels a finished card with the tool count and duration", () => {
    const html = markup({ live: false, stepCount: 2, durationMs: 12000 });
    expect(visibleText(html)).toContain("Done 2 tools 12s");
  });

  it("uses the singular for one tool", () => {
    expect(visibleText(markup({ live: false, stepCount: 1, durationMs: 850 }))).toContain(
      "Done 1 tool 850ms",
    );
    expect(visibleText(markup({ live: true, stepCount: 1 }))).toContain("Working… 1 tool");
  });

  it("omits the duration when it is not usable", () => {
    const html = markup({ live: false, stepCount: 3 });
    expect(visibleText(html)).toContain("Done 3 tools");
    expect(visibleText(html)).not.toMatch(/Done 3 tools \d/);
  });

  it("shows the live label while working", () => {
    const html = markup({ live: true, stepCount: 2 });
    expect(visibleText(html)).toContain("Working… 2 tools");
    expect(html).toContain('data-live="true"');
  });

  it("starts open while working", () => {
    expect(markup({ live: true, stepCount: 2 })).toMatch(OPEN_TRIGGER);
  });

  it("is collapsed once done and expands to the tool rows", () => {
    const html = markup({ live: false, stepCount: 2 });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(OPEN_TRIGGER);
    expect(html).toContain("Shell ×2");
  });

  it("folds when the run finishes", () => {
    const card = mountCard();
    card.render(true);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("true");

    card.render(false);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.summary()?.textContent).toContain("Done2 tools");
    card.unmount();
  });

  it("keeps a manual collapse while more tools arrive in the same run", () => {
    const card = mountCard();
    card.render(true, 2);
    flushSync(() => card.summary()?.click());
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");

    card.render(true, 3);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.summary()?.textContent).toContain("Working…3 tools");

    card.render(false, 3);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");
    card.unmount();
  });

  it("can still be expanded by hand once done", () => {
    const card = mountCard();
    card.render(false);
    flushSync(() => card.summary()?.click());
    expect(card.details()?.getAttribute("aria-expanded")).toBe("true");

    card.render(false);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("true");
    card.unmount();
  });
});

describe("ToolSteps", () => {
  // Each test replays its own calls into the shared live store.
  beforeEach(() => clearToolCallRecords());

  it("lists only the last steps and counts the earlier ones when limited", () => {
    const steps = stepsOf(LIVE_TOOL_STEP_WINDOW + 3, true);
    const html = renderToStaticMarkup(
      <ToolSteps steps={steps} live limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("+3 earlier steps");
    for (const hidden of ["step-0<", "step-1<", "step-2<"]) expect(html).not.toContain(hidden);
    for (let i = 3; i < steps.length; i++) expect(html).toContain(`step-${i}<`);
    // The pulsing marker stays on the step without a result after the window shifts the indexes.
    expect(html).toMatch(/◷<\/span><span[^>]*>step-8</);
    expect(html.match(/◷/g)).toHaveLength(1);
  });

  it("shows each call's detail, duration and outcome on its row", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        live={false}
        steps={[
          { label: "Shell", count: 1, detail: "pnpm test", outcome: "ok", durationMs: 2500 },
          { label: "Read file", count: 1, detail: "missing.txt", outcome: "error", durationMs: 8 },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("✓ Shell pnpm test 2.5s ✕ Read file missing.txt 8ms");
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('title="pnpm test"');
  });

  it("opens a row to its command and output, which follow the run's records", () => {
    replayToolCallRecords("run-1", [
      {
        executionId: "x1",
        name: "shell",
        status: "running",
        command: "pnpm test --filter web",
        output: "RUN v4\n",
      },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    const steps = [
      { label: "Shell", count: 1, executionId: "x1", detail: "pnpm test --filter web" },
    ];
    flushSync(() => root.render(<ToolSteps steps={steps} live source={MESSAGE} />));
    const row = container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="tool-step-panel"]')).toBeNull();

    flushSync(() => row?.click());
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    // The chat's own code block draws the command and its output as one console block.
    const code = () => container.querySelector('[data-testid="tool-step-code"] pre')?.textContent;
    expect(code()).toBe("$ pnpm test --filter web\nRUN v4\n");
    expect(container.querySelector('[data-testid="tool-step-exit"]')).toBeNull();

    // The command finishes: its exit code and final output land without reopening the row.
    flushSync(() =>
      replayToolCallRecords("run-1", [
        {
          executionId: "x1",
          name: "shell",
          status: "done",
          outcome: "error",
          command: "pnpm test --filter web",
          output: "RUN v4\n1 failed",
          exitCode: 1,
          durationMs: 4200,
        },
      ]),
    );
    expect(code()).toBe("$ pnpm test --filter web\nRUN v4\n1 failed\n");
    expect(container.querySelector('[data-testid="tool-step-exit"]')?.textContent).toBe("exit 1");

    flushSync(() => row?.click());
    expect(container.querySelector('[data-testid="tool-step-panel"]')).toBeNull();
    root.unmount();
  });

  it("shows a structured call's arguments and indents its JSON result", () => {
    replayToolCallRecords("run-1", [
      {
        executionId: "x1",
        name: "web_search",
        status: "done",
        outcome: "succeeded",
        input: '{\n  "query": "weather"\n}',
        output: '{"results":[{"title":"Sunny"}]}',
      },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ToolSteps
          live={false}
          source={MESSAGE}
          steps={[{ label: "Web search", count: 1, executionId: "x1", detail: "weather" }]}
        />,
      ),
    );
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]')?.click(),
    );
    const blocks = [...container.querySelectorAll('[data-testid="tool-step-code"] pre')].map(
      (pre) => pre.textContent,
    );
    expect(blocks).toEqual([
      '{\n  "query": "weather"\n}\n',
      '{\n  "results": [\n    {\n      "title": "Sunny"\n    }\n  ]\n}\n',
    ]);
    expect(container.textContent).not.toContain("$ ");
    root.unmount();
  });

  it("shows only the exit code for a call that ran and printed nothing", () => {
    replayToolCallRecords("run-1", [
      { executionId: "x1", name: "write_file", status: "done", exitCode: 0, durationMs: 12 },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ToolSteps
          live={false}
          source={MESSAGE}
          steps={[{ label: "Write file", count: 1, executionId: "x1", detail: "/tmp/a.py" }]}
        />,
      ),
    );
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]')?.click(),
    );
    expect(container.querySelector('[data-testid="tool-step-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-step-exit"]')?.textContent).toBe("exit 0");
    root.unmount();
  });

  it("keeps a row open when a repeated call joins it under a new call id", () => {
    replayToolCallRecords("run-1", [
      { executionId: "x1", name: "shell", status: "done", command: "ls", output: "a" },
      { executionId: "x2", name: "shell", status: "running", command: "ls", output: "" },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (executionId: string, count: number) =>
      flushSync(() =>
        root.render(
          <ToolSteps
            live
            source={MESSAGE}
            steps={[{ label: "Shell", count, executionId, detail: "ls" }]}
          />,
        ),
      );
    render("x1", 1);
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]')?.click(),
    );
    expect(container.querySelector('[data-testid="tool-step-panel"]')).not.toBeNull();
    render("x2", 2);
    expect(container.querySelector('[data-testid="tool-step-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tool-step"]')?.textContent).toContain("Shell ×2");
    root.unmount();
  });

  it("shows nothing but the running mark for a call that has not printed yet", () => {
    replayToolCallRecords("run-1", [{ executionId: "x1", name: "shell", status: "running" }]);
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ToolSteps
          live
          source={MESSAGE}
          steps={[{ label: "Shell", count: 1, executionId: "x1", detail: "sleep 9" }]}
        />,
      ),
    );
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]')?.click(),
    );
    expect(container.querySelector('[data-testid="tool-step-empty"]')).toBeNull();
    root.unmount();
  });

  it("says nothing about output that is only withheld from this reader", () => {
    replayToolCallRecords("run-1", [
      { executionId: "x1", name: "read_history", status: "done", withheld: true },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ToolSteps
          live={false}
          source={MESSAGE}
          steps={[{ label: "Read history", count: 1, executionId: "x1", outcome: "ok" }]}
        />,
      ),
    );
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-step"]')?.click(),
    );
    expect(container.querySelector('[data-testid="tool-step-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tool-step-empty"]')).toBeNull();
    root.unmount();
  });

  it("says when a call left no output and keeps rows without a call id plain", () => {
    replayToolCallRecords("run-1", [{ executionId: "x1", name: "remember", status: "done" }]);
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ToolSteps
          live={false}
          source={MESSAGE}
          steps={[
            { label: "Remember", count: 1, executionId: "x1" },
            { label: "Old step", count: 1 },
          ]}
        />,
      ),
    );
    const rows = container.querySelectorAll('[data-testid="tool-step"]');
    expect(rows[0]?.tagName).toBe("BUTTON");
    expect(rows[1]?.tagName).toBe("DIV");
    flushSync(() => (rows[0] as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="tool-step-empty"]')?.textContent).toBe(
      "No output recorded.",
    );
    root.unmount();
  });

  it("uses the singular for one hidden step", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW + 1)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("+1 earlier step<");
  });

  it("exposes the full label as the title of a truncated step", () => {
    const label = "Read apps/web/src/components/ToolActivityDisclosure.tsx";
    const html = renderToStaticMarkup(<ToolSteps steps={[{ label, count: 2 }]} />);
    expect(html).toContain(`title="${label}"`);
  });

  it("lists every step when not limited or when the list fits", () => {
    const all = renderToStaticMarkup(<ToolSteps steps={stepsOf(9)} />);
    const fits = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(all).not.toContain("earlier");
    expect(fits).not.toContain("earlier");
    for (let i = 0; i < 9; i++) expect(all).toContain(`step-${i}<`);
  });

  it("shows what the bot wrote before a step above it", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Read calendar", count: 1 },
          { label: "Save event", count: 1, note: "The meeting is with **Anna**." },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("✓ Read calendar The meeting is with Anna . ✓ Save event");
    expect(html).toContain("<strong>Anna</strong>");
  });
});

describe("StandaloneToolActivity", () => {
  it("renders as a plain line, not a chat bubble", () => {
    const html = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={stepsOf(2)} stepCount={2} durationMs={4000} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toContain("Done 2 tools 4s");
    expect(html).not.toContain("bg-muted");
    expect(html).not.toContain("rounded-[20px]");
  });

  it("is open with a windowed list while live, and lists every step once done", () => {
    const steps = stepsOf(9);
    const live = renderToStaticMarkup(
      <StandaloneToolActivity live steps={stepsOf(9, true)} stepCount={9} />,
    );
    expect(live).toMatch(OPEN_TRIGGER);
    expect(live).toContain("+3 earlier steps");

    const done = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={steps} stepCount={9} />,
    );
    expect(done).not.toMatch(OPEN_TRIGGER);
    expect(done).not.toContain("earlier");
    for (let i = 0; i < 9; i++) expect(done).toContain(`step-${i}<`);
  });
});

describe("ToolOnlyNarration", () => {
  it("renders a live tools-only message as an open slim line, not a bubble", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live
        blocks={[{ kind: "steps", steps: stepsOf(2, true) }]}
        message={MESSAGE}
      />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toMatch(/Working… 2 tools \d+/);
    expect(html).toMatch(OPEN_TRIGGER);
    expect(html).not.toContain("bg-muted");
  });

  it("folds each card once the run is done", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live={false}
        blocks={[
          { kind: "steps", steps: stepsOf(3), durationMs: 12_000 },
          { kind: "steps", steps: stepsOf(1) },
        ]}
        message={MESSAGE}
      />,
    );
    expect(html.match(/data-testid="tool-activity-line"/g)).toHaveLength(2);
    expect(visibleText(html)).toContain("Done 3 tools 12s");
    expect(html).not.toMatch(OPEN_TRIGGER);
  });
});
