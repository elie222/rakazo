// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BotWorkLog } from "./BotWorkLog";

const read = vi.hoisted(() => ({ result: {} as Record<string, unknown>, refetch: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({ bots: { workLog: { queryOptions: () => ({}) } } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => read.result }));

const at = new Date().toISOString();
const entry = (id: string, tool: string, action?: object) => ({
  id,
  createdAt: at,
  runId: "run-1",
  tool,
  ...(action ? { action } : {}),
});
const command = {
  executionId: "e1",
  cwd: "/work",
  status: "done",
  exitCode: 0,
  output: "",
};

let root: Root | undefined;

async function render(result: Record<string, unknown>) {
  read.result = { refetch: read.refetch, ...result };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(<BotWorkLog botId="bot-1" />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("lists what the bot did: commands, files with their size, and tools with no computer action", async () => {
  await render({
    isPending: false,
    isError: false,
    data: [
      entry("1", "shell", {
        ...command,
        kind: "shell",
        command: "pnpm test",
        exitCode: 2,
        output: "1 failed",
      }),
      entry("2", "write_file", {
        ...command,
        kind: "write_file",
        command: "notes/a.txt",
        bytes: 2048,
      }),
      entry("3", "web_search"),
    ],
  });
  const rows = [...document.querySelectorAll("li")].map((row) => row.textContent);
  expect(rows).toEqual([
    "pnpm testshellExit code 2just now",
    "notes/a.txtwrite_file2 KBjust now",
    "web_searchjust now",
  ]);
});

it("keeps a command's output behind its row until it is opened", async () => {
  await render({
    isPending: false,
    isError: false,
    data: [entry("1", "shell", { ...command, kind: "shell", command: "ls", output: "a.txt" })],
  });
  expect(document.body.textContent).not.toContain("a.txt");
  await act(async () => document.querySelector<HTMLElement>("li button")!.click());
  expect(document.querySelector("pre")?.textContent).toBe("a.txt");
});

it("says so when nothing was recorded, and offers a retry when the read fails", async () => {
  await render({ isPending: false, isError: false, data: [] });
  expect(document.body.textContent).toBe("No activity yet.");
  await render({ isPending: false, isError: true });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't load logs.Try again",
  );
  await act(async () => document.querySelector("button")!.click());
  expect(read.refetch).toHaveBeenCalledOnce();
});
