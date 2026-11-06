// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolActivityCard } from "../components/thread/tool-activity-card";
import { toolCallRecords } from "./tool-call-records";

const { rpc, setStringAsync } = vi.hoisted(() => ({
  rpc: vi.fn(),
  setStringAsync: vi.fn(async () => true),
}));
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-clipboard", () => ({ setStringAsync }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
  }),
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
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

  it("opens a row to the live command, output and exit code, and copies the output", async () => {
    toolCallRecords.seed("run-1", [
      { executionId: "x1", name: "shell", status: "running", command: "pnpm test", output: "RUN" },
    ]);
    act(() =>
      root.render(<ToolActivityCard block={steps} live runId="run-1" threadId="thread-1" />),
    );
    expect(rows()).toHaveLength(3);
    act(() => rows()[0]!.click());
    expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="tool-step-output"]')?.textContent).toBe("RUN▍");
    expect(rpc).not.toHaveBeenCalled();

    act(() =>
      toolCallRecords.seed("run-1", [
        {
          executionId: "x1",
          name: "shell",
          status: "done",
          command: "pnpm test",
          output: "RUN\n1 failed",
          exitCode: 1,
        },
      ]),
    );
    expect(container.textContent).toContain("exit 1");
    const buttons = () => [...container.querySelectorAll("button")];
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "Copy")
        ?.click(),
    );
    expect(setStringAsync).toHaveBeenCalledWith("pnpm test");
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "Copy output")
        ?.click(),
    );
    expect(setStringAsync).toHaveBeenCalledWith("RUN\n1 failed");
    expect(container.textContent).toContain("Copied");
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
