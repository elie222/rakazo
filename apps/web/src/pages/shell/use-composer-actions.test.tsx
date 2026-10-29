// @vitest-environment jsdom

import type { Me } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

it.each([undefined, 1, 8])(
  "uses the server attachment count with a fallback (%s)",
  (maxAttachmentsPerMessage) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let actions: ReturnType<typeof useComposerActions>;
    function Harness() {
      actions = useComposerActions({
        rpc: {} as Parameters<typeof useComposerActions>[0]["rpc"],
        activeId: "bot-1",
        inGroup: false,
        groupId: undefined,
        activeBotId: { current: "bot-1" },
        activeGroupId: { current: undefined },
        botsRef: { current: [] },
        bootstrapMe: { maxAttachmentsPerMessage } as Me,
        activeSnapshot: null,
        navigate: vi.fn(),
        refreshBots: vi.fn(),
        refreshThreadRef: { current: vi.fn() },
        refreshGroupThreadRef: { current: vi.fn() },
        updateSnapshot: vi.fn(),
        terminalRunReceipts: { current: new Set() },
        computerRef: { current: null },
        commitComputer: vi.fn(),
        clearReadBoundary: vi.fn(),
        flushPendingBrowserNotifications: vi.fn(),
      });
      return null;
    }
    root = createRoot(container);
    act(() => root.render(<Harness />));
    const files = Array.from(
      { length: 9 },
      (_, i) => new File(["a"], `${i}.txt`, { type: "text/plain" }),
    );
    act(() => {
      actions.onAttachmentPick(files);
    });
    const limit = maxAttachmentsPerMessage ?? 4;
    expect(actions!.activePendingAttachments).toHaveLength(limit);
    expect(actions!.attachmentNotice).toContain(`max ${limit} attachments`);
  },
);
