// @vitest-environment jsdom

import type { ComputerCommand, ProductEvent } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { publishComputerCommand } from "../../lib/computer-workspace";

const history = vi.hoisted(() => ({
  impl: vi.fn<(...args: unknown[]) => Promise<ComputerCommand[]>>(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: { computer: { commands: (...args: unknown[]) => history.impl(...args) } },
}));

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }) };
});

const term = vi.hoisted(() => {
  const api = {
    writes: [] as string[],
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    write(data: string) {
      api.writes.push(data);
    },
  };
  return api;
});

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function Terminal() {
    return term;
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddon() {
    return { fit: vi.fn() };
  }),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import TerminalApp from "./TerminalApp";

const shell = (overrides: Partial<ComputerCommand> = {}): ComputerCommand => ({
  executionId: "call-1",
  kind: "shell",
  command: "echo hi",
  cwd: ".",
  status: "done",
  exitCode: 0,
  output: "hi\n",
  ...overrides,
});

function emit(botId: string, command: ComputerCommand) {
  publishComputerCommand({
    type: "computer.command",
    botId,
    payload: command,
  } as unknown as ProductEvent);
}

function hangHistory() {
  let resolve!: (commands: ComputerCommand[]) => void;
  const first = new Promise<ComputerCommand[]>((done) => {
    resolve = done;
  });
  let calls = 0;
  history.impl.mockImplementation(() => {
    calls += 1;
    return calls === 1 ? first : new Promise<ComputerCommand[]>(() => undefined);
  });
  return resolve;
}

async function renderTerminal() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TerminalApp botId="bot-1" />);
  });
  return {
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  term.writes.length = 0;
  history.impl.mockReset();
});

it("keeps the terminal blank until history settles, then shows the empty state", async () => {
  const resolveHistory = hangHistory();
  const view = await renderTerminal();
  try {
    expect(term.writes).toEqual([]);
    await act(async () => resolveHistory([]));
    expect(term.writes).toEqual(["\x1bc\x1b[2mNo bot activity yet.\x1b[0m\r\n"]);
  } finally {
    await view.cleanup();
  }
});

it("replaces the settled empty state when a live command arrives", async () => {
  const resolveHistory = hangHistory();
  const view = await renderTerminal();
  try {
    await act(async () => resolveHistory([]));
    await act(async () => emit("bot-1", shell()));
    expect(term.writes.at(-1)).toBe("\x1bc\x1b[1m$ echo hi\x1b[0m\r\nhi\r\n");
  } finally {
    await view.cleanup();
  }
});

it("shows a live command that arrives before history and keeps it when that page is empty", async () => {
  const resolveHistory = hangHistory();
  const view = await renderTerminal();
  try {
    await act(async () => emit("bot-1", shell()));
    expect(term.writes).toEqual(["\x1bc\x1b[1m$ echo hi\x1b[0m\r\nhi\r\n"]);
    await act(async () => resolveHistory([]));
    expect(term.writes).toEqual([
      "\x1bc\x1b[1m$ echo hi\x1b[0m\r\nhi\r\n",
      "\x1bc\x1b[1m$ echo hi\x1b[0m\r\nhi\r\n",
    ]);
  } finally {
    await view.cleanup();
  }
});
