// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolActivityCard } from "../components/thread/tool-activity-card";
import { toolCallRecords } from "./tool-call-records";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./tool-call-reads", () => ({
  readFinishedRunToolCalls: (_runId: string, _executionId: string, read: () => Promise<unknown>) =>
    read(),
}));
// The chat's markdown draws the code block; here its source is enough to check.
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: string }) =>
    createElement("pre", { "data-testid": "markdown" }, children),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
  }),
}));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "dark",
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("react-native", () => {
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  const Pressable = ({
    children,
    testID,
    accessibilityLabel,
    accessibilityState,
    onPress,
    disabled,
  }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    testID?: string;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        "aria-expanded": accessibilityState?.expanded,
        disabled,
        onClick: onPress,
      },
      typeof children === "function" ? children({ pressed: false }) : children,
    );
  return {
    Platform: { select: (options: { default: string }) => options.default },
    Pressable,
    ScrollView: view,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: view,
    View: view,
  };
});

const steps: Extract<MessageBlock, { kind: "steps" }> = {
  kind: "steps",
  steps: [
    {
      label: "Shell",
      count: 1,
      executionId: "x1",
      detail: "pnpm test",
      outcome: "ok",
      durationMs: 2500,
    },
    { label: "Read file", count: 1, executionId: "x2", detail: "missing.txt", outcome: "error" },
    { label: "Old step", count: 1 },
  ],
  durationMs: 4000,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpc.mockReset();
  rpc.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  toolCallRecords.clear();
});

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="tool-step"]')];

describe("mobile tool activity card", () => {
  it("folds a finished run and opens to rows that name each call and its result", () => {
    act(() => root.render(<ToolActivityCard block={steps} live={false} runId="run-1" />));
    const header = container.querySelector<HTMLButtonElement>("button")!;
    expect(header.getAttribute("aria-label")).toBe("Done  3 tools  4s");
    expect(rows()).toHaveLength(0);
    act(() => header.click());
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Done, Shell, pnpm test, 2.5s",
      "Failed, Read file, missing.txt",
      "Done, Old step",
    ]);
    // A row saved without a call id has nothing to open.
    expect(rows()[2]?.disabled).toBe(true);
  });

  /** The live events of one shell call, through the same path the thread's events take. */
  function shell(frame: { status: "running" | "done"; exitCode: number | null; output: string }) {
    toolCallRecords.record({
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "shell", executionId: "x1" },
    });
    toolCallRecords.record({
      type: "computer.command",
      runId: "run-1",
      payload: { executionId: "x1", kind: "shell", command: "pnpm test", cwd: ".", ...frame },
    });
  }

  it("opens a row to the live command and output, which follow the run's records", () => {
    shell({ status: "running", exitCode: null, output: "RUN" });
    // The first call is still running: its step has no outcome yet.
    const running = {
      ...steps,
      steps: steps.steps.map((step, index) =>
        index === 0
          ? { label: step.label, count: 1, executionId: "x1", detail: step.detail }
          : step,
      ),
    };
    act(() =>
      root.render(<ToolActivityCard block={running} live runId="run-1" threadId="thread-1" />),
    );
    expect(rows()).toHaveLength(3);
    act(() => rows()[0]!.click());
    expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
    const code = () => container.querySelector('[data-testid="markdown"]')?.textContent;
    expect(code()).toBe("```console\n$ pnpm test\nRUN\n```");
    expect(rpc).not.toHaveBeenCalled();

    act(() => shell({ status: "done", exitCode: 1, output: "RUN\n1 failed" }));
    expect(code()).toBe("```console\n$ pnpm test\nRUN\n1 failed\n```");
    expect(container.textContent).toContain("exit 1");
  });

  it("reads a finished run's results once when the thread's events did not carry them", async () => {
    rpc.mockResolvedValue([
      { executionId: "x2", name: "read_file", status: "done", outcome: "error", error: "ENOENT" },
    ]);
    act(() =>
      root.render(
        <ToolActivityCard block={steps} live={false} runId="run-1" threadId="thread-1" />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => rows()[1]!.click());
    expect(rpc).toHaveBeenCalledWith("threads/toolCalls", { threadId: "thread-1", runId: "run-1" });
    expect(container.textContent).toContain("ENOENT");
    expect(container.textContent).not.toContain("No output recorded.");
  });
});
