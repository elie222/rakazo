// @vitest-environment jsdom

import { AiConsentBlocked, resolveComposerSendPlan } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailedSendBubble } from "../components/failed-send-bubble";
import type { ComposerSnapshot, SendPayload } from "./thread-feedback";
import {
  clearFailedSends,
  configureUnsentSends,
  confirmEchoes,
  restoreUnsentSends,
  sendWaitingMessages,
  settleComposer,
  useThreadFeedback,
} from "./thread-feedback";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  Image: () => null,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityHint,
    onLongPress,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityHint?: string;
    onLongPress: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        onContextMenu: onLongPress,
        disabled,
        "aria-label": accessibilityLabel,
        "aria-description": accessibilityHint,
      },
      children,
    ),
  Platform: { OS: "ios" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));

let feedback: ReturnType<typeof useThreadFeedback>;
let nonces = 0;
const retry = vi.fn();
function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  return feedback.unsentSends.map((attempt) => (
    <FailedSendBubble
      key={attempt.clientNonce}
      attempt={attempt}
      onRetry={retry}
      onDelete={() => feedback.discard(attempt)}
    />
  ));
}

function payload(text = "Hello"): SendPayload {
  return {
    originThreadKey: "bot-1",
    displayText: text,
    replyPreview: "Quoted message",
    initialBotTarget: "bot-1",
    botTarget: "bot-1",
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text, mentions: [], hasAttachments: true }),
    attachments: [
      { id: "attachment-1", name: "photo.png", mimeType: "image/png", contentBase64: "fake" },
    ],
    replyTargetId: "reply-1",
    replyQuote: "Quoted message",
  };
}

describe("composer settlement", () => {
  const submitted: ComposerSnapshot = {
    promptText: "Hello",
    mentions: [{ kind: "bot", id: "bot-1", name: "Bot" }],
    skill: null,
    replyTargetId: "reply-1",
    replyQuote: "Quoted message",
    attachmentIds: ["attachment-1"],
  };
  it("clears an unchanged composition", () => {
    expect(settleComposer(submitted, structuredClone(submitted))).toEqual({ clearComposer: true });
  });

  it.each<Partial<ComposerSnapshot>>([
    { promptText: "Edited" },
    { mentions: [{ kind: "bot", id: "bot-2", name: "Bot" }] },
    { skill: { id: "skill-1", name: "Skill", description: "", source: "user", readOnly: false } },
    { replyTargetId: "reply-2" },
    { replyQuote: "Edited quote" },
    { attachmentIds: ["attachment-1", "attachment-2"] },
    { attachmentIds: [] },
  ])("keeps an edited composition: %j", (edit) => {
    const current = { ...submitted, ...edit };
    const before = structuredClone(current);
    expect(settleComposer(submitted, current)).toEqual({ clearComposer: false });
    expect(current).toEqual(before);
  });
});

describe("scoped mobile outbox", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reachable = true;
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    cacheSession: "ns-a",
    spaceId: "space-a",
  };
  const request = vi.fn();
  const disk = {
    admit: vi.fn(() => true),
    hydrate: vi.fn(async () => undefined),
    forget: vi.fn(),
    load: vi.fn(() => []),
    save: vi.fn(),
    clear: vi.fn(),
  };
  const notDelivered = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    clearFailedSends();
    vi.clearAllMocks();
    reachable = true;
    scope.spaceId = "space-a";
    request.mockImplementation(async (proc) =>
      proc === "artifacts/create" ? { id: "artifact-a" } : { seq: 42 },
    );
    configureUnsentSends({
      request,
      scope: () => scope,
      serverReachable: () => reachable,
      disk,
      errorText: String,
      notDelivered,
    });
    restoreUnsentSends();
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root.render(<Probe threadKey="bot-1" />));
  });
  afterEach(() => {
    act(() => root.unmount());
    clearFailedSends();
    vi.unstubAllGlobals();
  });
  it("shows the optimistic payload before confirmation, then replaces it with the echo", async () => {
    let finish!: (value: { seq: number }) => void;
    request.mockImplementation(async (proc) =>
      proc === "artifacts/create"
        ? { id: "artifact-a" }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("Sending…");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const writes = disk.save.mock.calls.length;
    act(() => confirmEchoes("bot-1", []));
    expect(disk.save).toHaveBeenCalledTimes(writes);
    await act(async () => {
      finish({ seq: 42 });
      await sending;
    });
    act(() => confirmEchoes("bot-1", [42]));
    expect(container.textContent).toBe("");
  });
  it("keeps sends ordered, persisted and scoped while offline, and retries on reconnect", async () => {
    reachable = false;
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    await act(async () => {
      await feedback.send(first);
      await feedback.send(second);
    });
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Not sent · Tap to retry");
    expect(disk.save).toHaveBeenLastCalledWith([first, second]);
    reachable = true;
    await act(async () => {
      await sendWaitingMessages();
    });
    expect(
      request.mock.calls.filter(([proc]) => proc === "threads/send").map(([, body]) => body.text),
    ).toEqual(["First", "Second"]);
  });
  it("drops late failures and further uploads after a session wipe", async () => {
    let finish!: (value: { id: string }) => void;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => clearFailedSends());
    await act(async () => {
      finish({ id: "artifact-a" });
      await sending;
    });
    expect(request).toHaveBeenCalledOnce();
    expect(notDelivered).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    expect(disk.clear).toHaveBeenCalled();
  });
  it("reports real errors and reuses uploaded artifacts on manual retry", async () => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(new Error("Quota exceeded"));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(notDelivered).toHaveBeenCalledWith(attempt);
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(1);
    const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends[0]).toEqual(sends[1]);
  });
  it.each([false, true])("pauses the ordered queue on HTTP 429 (wrapped: %s)", async (wrapped) => {
    reachable = false;
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    await act(async () => {
      await feedback.send(first);
      await feedback.send(second);
    });
    reachable = true;
    const error = Object.assign(new Error("Slow down"), { status: 429 });
    request.mockRejectedValueOnce(wrapped ? new AiConsentBlocked("Consent check", error) : error);
    await act(async () => {
      await sendWaitingMessages();
    });
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");
    expect(request).toHaveBeenCalledOnce();
    expect(notDelivered).not.toHaveBeenCalled();
  });
  it("retries after a reconnect that arrived during an in-flight send", async () => {
    let rejectUpload!: (error: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );
    const attempt = feedback.sendAttempt(payload("Held"));
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(rejectUpload).toBeTypeOf("function"));
    const replay = sendWaitingMessages();
    await act(async () => {
      rejectUpload(Object.assign(new Error("unavailable"), { status: 503 }));
      await sending;
      await replay;
    });
    expect(attempt.acceptedSeq).toBe(42);
    expect(request.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    expect(notDelivered).not.toHaveBeenCalled();
  });
  it("allows Retry after a consent conflict before dispatch", async () => {
    const attempt = feedback.sendAttempt(payload());
    request.mockRejectedValueOnce(
      new AiConsentBlocked(
        "Review consent again",
        Object.assign(new Error("Changed"), { status: 409 }),
      ),
    );
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    await act(async () => {
      await feedback.send(attempt, true);
    });
    expect(attempt.acceptedSeq).toBe(42);
  });
  it("keeps the original Space while selection changes during an upload", async () => {
    let finish!: (value: { id: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    scope.spaceId = "space-b";
    await act(async () => {
      finish({ id: "artifact-a" });
      await sending;
    });
    const [send] = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(send?.[3]).toBe("space-a");
    expect(attempt.acceptedSeq).toBe(42);
  });
});
