// @vitest-environment jsdom

import { resolveComposerSendPlan } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailedSendBubble } from "../components/failed-send-bubble";
import type { ComposerSnapshot, SendPayload } from "./thread-feedback";
import { deliverSend, settleComposer, useThreadFeedback } from "./thread-feedback";

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
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

let feedback: ReturnType<typeof useThreadFeedback>;
let nonces = 0;
const retry = vi.fn();
function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  return feedback.failedSends.map((attempt) => (
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

describe("thread feedback", () => {
  let root: Root;
  let container: HTMLDivElement;
  function render(threadKey: string) {
    act(() => root.render(<Probe threadKey={threadKey} />));
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    Platform.OS = "ios";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render("bot-1");
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the outgoing payload and caption, and pressing it retries", () => {
    const attempt = feedback.sendAttempt(payload());
    act(() => feedback.sendFailed(attempt));
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("photo.png");
    expect(container.textContent).toContain("Quoted message");
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Hello, photo.png. Not sent · Tap to retry");
    expect(button.getAttribute("aria-description")).toBe("Long press to delete");
    act(() => button.click());
    expect(retry).toHaveBeenCalledOnce();
    act(() => feedback.start(attempt));
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Sending…");
    expect(button.getAttribute("aria-label")).toBe("Hello, photo.png. Sending…");
    expect(button.hasAttribute("aria-description")).toBe(false);
    expect(feedback.start(attempt)).toBe(false);
    act(() => feedback.sendFailed(attempt));
    expect(button.disabled).toBe(false);
  });

  it("keeps the first delivery out of the failed bubbles until it fails", async () => {
    const attempt = feedback.sendAttempt(payload());
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, rejectRequest) => {
      reject = rejectRequest;
    });
    const request = vi.fn().mockReturnValue(pending);
    act(() => {
      feedback.start(attempt);
    });
    const delivery = deliverSend(attempt.payload, attempt, request);
    expect(attempt.sending).toBe(true);
    expect(container.textContent).toBe("");
    expect(feedback.failedSends).toEqual([]);
    reject(new Error("Quota exceeded"));
    await expect(delivery).rejects.toThrow("Quota exceeded");
    act(() => {
      attempt.error = "Quota exceeded";
      feedback.sendFailed(attempt);
    });
    expect(container.textContent).toContain("Not sent · Tap to retry");
  });

  it("reuses the frozen target, nonce, routine nonces, and uploaded artifact ids on retry", async () => {
    const frozen = payload();
    frozen.groupTarget = "rerouted-group";
    frozen.botTarget = undefined;
    frozen.reroutedToGroup = true;
    frozen.plan.shouldRunRoutines = true;
    frozen.plan.routineIds = ["routine-1"];
    const attempt = feedback.sendAttempt(frozen);
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      if (method === "threads/send") throw new Error("Response lost");
    });
    await expect(deliverSend(frozen, attempt, request)).rejects.toThrow("Response lost");
    act(() => feedback.sendFailed(attempt));
    render("bot-2");
    request.mockImplementation(async (method: string) =>
      method === "artifacts/create" ? { id: "artifact-2" } : undefined,
    );
    await deliverSend(attempt.payload, attempt, request);
    const sends = request.mock.calls.filter(([method]) => method === "threads/send");
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual(sends[1]);
    expect(sends[1]![1]).toMatchObject({
      groupId: "rerouted-group",
      text: "Hello",
      clientNonce: attempt.clientNonce,
      artifactIds: ["artifact-1"],
    });
    expect(sends[1]![1].replyToMessageId).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "artifacts/create")).toHaveLength(1);
    const routines = request.mock.calls.filter(([method]) => method === "routines/testRun");
    expect(routines[0]).toEqual(routines[1]);
    expect(routines[1]![1].clientNonce).toBe(`routine-mention:${attempt.clientNonce}:routine-1`);
    act(() => feedback.sent(attempt));
    render("bot-1");
    expect(feedback.failedSends).toEqual([]);
  });

  it("retains completed uploads when a later attachment fails", async () => {
    const frozen = payload();
    frozen.attachments.push({ ...frozen.attachments[0]!, id: "attachment-2" });
    const attempt = feedback.sendAttempt(frozen);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "artifact-1" })
      .mockRejectedValueOnce(new Error("Upload interrupted"));
    await expect(deliverSend(frozen, attempt, request)).rejects.toThrow("Upload interrupted");
    request.mockResolvedValueOnce({ id: "artifact-2" }).mockResolvedValueOnce(undefined);
    await deliverSend(frozen, attempt, request);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3]![1]).toMatchObject({ artifactIds: ["artifact-1", "artifact-2"] });
  });

  it("offers native retry, destructive delete, and cancel with the failure reason", () => {
    const attempt = feedback.sendAttempt(payload());
    attempt.error = "Quota exceeded";
    act(() => feedback.sendFailed(attempt));
    act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    const showSheet = vi.mocked(ActionSheetIOS.showActionSheetWithOptions);
    expect(showSheet).toHaveBeenCalledWith(
      {
        message: "Quota exceeded",
        options: ["Try Again", "Delete", "Cancel"],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      expect.any(Function),
    );
    const choose = showSheet.mock.calls[0]![1];
    act(() => choose(2));
    expect(feedback.failedSends).toEqual([attempt]);
    act(() => choose(0));
    expect(retry).toHaveBeenCalledOnce();
    act(() => choose(1));
    expect(feedback.failedSends).toEqual([]);
  });

  it("shows the latest failure reason in the Android alert", () => {
    Platform.OS = "android";
    const attempt = feedback.sendAttempt(payload());
    act(() => {
      attempt.error = "Quota exceeded";
      feedback.sendFailed(attempt);
    });
    act(() => feedback.start(attempt));
    act(() => {
      attempt.error = "Bot archived";
      feedback.sendFailed(attempt);
    });
    act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(Alert.alert).toHaveBeenCalledWith("Not sent · Tap to retry", "Bot archived", [
      { text: "Try Again", onPress: retry },
      { text: "Delete", style: "destructive", onPress: expect.any(Function) },
      { text: "Cancel", style: "cancel" },
    ]);
  });

  it("gives new and edited messages fresh nonces and upload caches", () => {
    const failed = feedback.sendAttempt(payload());
    failed.artifactIds.set("attachment-1", "artifact-1");
    act(() => feedback.sendFailed(failed));
    for (const text of ["Hello", "Edited"]) {
      const fresh = feedback.sendAttempt(payload(text));
      expect(fresh.clientNonce).not.toBe(failed.clientNonce);
      expect(fresh.artifactIds.size).toBe(0);
    }
  });

  it("keeps failures scoped to the origin and does not replace another failed message", () => {
    const first = feedback.sendAttempt(payload());
    const second = feedback.sendAttempt(payload("Another"));
    act(() => {
      feedback.sendFailed(first);
      feedback.sendFailed(second);
    });
    render("bot-2");
    expect(feedback.failedSends).toEqual([]);
    expect(container.textContent).toBe("");
    render("bot-1");
    expect(feedback.failedSends).toEqual([first, second]);
    act(() => feedback.discard(first));
    expect(feedback.failedSends).toEqual([second]);
  });

  it("keeps load failures separate from sends and clears them when a refresh reaches the server", () => {
    act(() => feedback.setError("Could not reach the server"));
    act(() => feedback.sendFailed(feedback.sendAttempt(payload())));
    expect(feedback.error).toBe("Could not reach the server");
    act(() => feedback.refreshed());
    expect(feedback.error).toBeNull();
    act(() => feedback.setError("Load failed"));
    render("bot-2");
    expect(feedback.error).toBeNull();
    act(() => feedback.setError("Current load failed"));
    act(() => feedback.refreshed("bot-1"));
    expect(feedback.error).toBe("Current load failed");
  });
});
