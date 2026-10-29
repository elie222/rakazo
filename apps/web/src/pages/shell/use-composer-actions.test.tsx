// @vitest-environment jsdom
import type { Bot, ComputerStatus, Me, ThreadSnapshot } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useComposerActions } from "./use-composer-actions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
}));
vi.mock("../../lib/prepare-image", () => ({
  canPrepareImage: () => false,
  prepareImage: async (file: File) => file,
}));

type Rpc = {
  routines: { testRun: ReturnType<typeof vi.fn> };
  artifacts: { create: ReturnType<typeof vi.fn> };
  threads: { send: ReturnType<typeof vi.fn> };
};

let rpc: Rpc;
let me: Me | null;
let root: Root;
let latest: ReturnType<typeof useComposerActions>;

function ref<T>(current: T) {
  return { current };
}

function Harness() {
  latest = useComposerActions({
    rpc: rpc as unknown as ReturnType<typeof createSpaceRpc>,
    activeId: "bot-1",
    inGroup: false,
    groupId: undefined,
    activeBotId: ref<string | undefined>("bot-1"),
    activeGroupId: ref<string | undefined>(undefined),
    botsRef: ref<Bot[]>([]),
    bootstrapMe: me,
    activeSnapshot: null,
    navigate: vi.fn(),
    refreshBots: async () => undefined,
    refreshThreadRef: ref(async () => ({}) as ThreadSnapshot),
    refreshGroupThreadRef: ref(async () => ({}) as ThreadSnapshot),
    updateSnapshot: () => undefined,
    terminalRunReceipts: ref(new Set<string>()),
    computerRef: ref<ComputerStatus | null>(null),
    commitComputer: () => undefined,
    clearReadBoundary: () => undefined,
    flushPendingBrowserNotifications: () => undefined,
  });
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  me = null;
  rpc = {
    routines: { testRun: vi.fn() },
    artifacts: { create: vi.fn() },
    threads: { send: vi.fn() },
  };
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

it.each([undefined, 1, 8])(
  "uses the server attachment count with a fallback (%s)",
  (maxAttachmentsPerMessage) => {
    me = { maxAttachmentsPerMessage } as Me;
    act(() => root.render(<Harness />));
    const files = Array.from(
      { length: 9 },
      (_, i) => new File(["a"], `${i}.txt`, { type: "text/plain" }),
    );
    act(() => {
      latest.onAttachmentPick(files);
    });
    const limit = maxAttachmentsPerMessage ?? 4;
    expect(latest.activePendingAttachments).toHaveLength(limit);
    expect(latest.attachmentNotice).toContain(`max ${limit} attachments`);
  },
);

it("keeps an attachment added while a send is in flight", async () => {
  const fileA = new File(["a"], "a.txt", { type: "text/plain" });
  const fileB = new File(["b"], "b.txt", { type: "text/plain" });
  rpc.artifacts.create.mockImplementation(async ({ name }: { name: string }) => ({
    id: `artifact-${name}`,
  }));
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  act(() => void latest.onAttachmentPick([fileA]));

  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("", [], "nonce-1");
  });
  await flush();
  act(() => void latest.onAttachmentPick([fileB]));
  finishSend();
  await act(async () => void (await sent));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ artifactIds: ["artifact-a.txt"] }),
  );
  expect(latest.activePendingAttachments.map((pending) => pending.file)).toEqual([fileB]);
});
