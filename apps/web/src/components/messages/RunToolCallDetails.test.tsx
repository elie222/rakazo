// @vitest-environment jsdom

import type { ToolCallRecord } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({ toolCalls: vi.fn() }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { runs },
  rpcForSpace: () => ({ runs }),
  createSpaceRpc: () => ({ runs }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { callsToExplain, RunToolCallDetails, ToolCallExplanations } from "./RunToolCallDetails";

afterEach(() => {
  runs.toolCalls.mockReset();
  document.body.innerHTML = "";
});

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    executionId: "exec-1",
    tool: "mail_execute",
    durationMs: 1200,
    outcome: "succeeded",
    ...overrides,
  };
}

function markup(calls: ToolCallRecord[]): string {
  return renderToStaticMarkup(<ToolCallExplanations calls={calls} />);
}

/** The words a reader sees, with each element's text as its own word. */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("ToolCallExplanations", () => {
  it("explains a failed call with what it was sent and what it answered", () => {
    const text = visibleText(
      markup([
        record({
          outcome: "failed",
          arguments: '{"query":"in:inbox"}',
          error: "401 Unauthorized",
        }),
      ]),
    );
    expect(text).toContain("mail_execute");
    expect(text).toContain("Failed");
    expect(text).toContain("1.2s");
    expect(text).toContain('{"query":"in:inbox"}');
    expect(text).toContain("401 Unauthorized");
  });

  it("says a result came back cut short, and how big it was", () => {
    const text = visibleText(
      markup([record({ arguments: "{}", resultBytes: 4_321, resultShortened: true })]),
    );
    expect(text).toContain("mail_execute");
    expect(text).toContain("Result shortened 4.2 KB");
  });

  it("shows nothing for a call that just worked", () => {
    expect(markup([record({ arguments: "{}", resultBytes: 20 })])).toBe("");
  });

  it("shows nothing when the run kept no records", () => {
    expect(markup([])).toBe("");
  });

  it("leaves out the calls that need no explanation and keeps the rest", () => {
    const explained = callsToExplain([
      record({ executionId: "a" }),
      record({ executionId: "b", outcome: "failed", error: "boom" }),
      record({ executionId: "c", outcome: "paused" }),
      record({ executionId: "d", resultShortened: true, resultBytes: 900 }),
    ]);
    expect(explained.map((call) => call.executionId)).toEqual(["b", "d"]);
  });
});

describe("RunToolCallDetails", () => {
  it("reads the run's records and shows the one that failed", async () => {
    runs.toolCalls.mockImplementation(async () => ({
      calls: [record({ outcome: "failed", error: "quota exceeded" })],
    }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunToolCallDetails runId="run-1" />
        </QueryClientProvider>,
      );
    });
    expect(runs.toolCalls).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());
    await act(flush);
    expect(visibleText(container.innerHTML)).toContain("quota exceeded");
    act(() => root.unmount());
  });

  it("reads nothing into the page when the server refuses the run", async () => {
    runs.toolCalls.mockRejectedValue(new Error("nope"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunToolCallDetails runId="run-2" />
        </QueryClientProvider>,
      );
    });
    await act(flush);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });
});
