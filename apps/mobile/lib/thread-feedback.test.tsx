// @vitest-environment jsdom

import * as core from "@rakazo/core";
import { AiConsentBlocked, MODEL_REQUIRED_SEND_ERROR, resolveComposerSendPlan } from "@rakazo/core";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { act, createElement, useMemo } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailedSendBubble } from "../components/failed-send-bubble";
import type { MobileSnapshot, rpc } from "./api";
import { applyMobileThreadEvent } from "./api";
import { filterPickedAttachments } from "./pick-attachments-filter";
import type { ComposerSnapshot, SendAttempt, SendPayload } from "./thread-feedback";
import {
  clearFailedSends,
  configureUnsentSends,
  confirmEchoes,
  deliverSend,
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
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));

let feedback: ReturnType<typeof useThreadFeedback>;
let nonces = 0;
let needsModel: boolean | undefined;
const retry = vi.fn();
function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  return feedback.unsentSends.map((attempt) => (
    <FailedSendBubble
      key={attempt.clientNonce}
      attempt={attempt}
      onRetry={retry}
      onDelete={() => feedback.discard(attempt)}
      needsModel={needsModel}
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
    load: vi.fn((): SendAttempt[] => []),
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
      errorText: (error) => (error instanceof Error ? error.message : String(error)),
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
  it.each(["Outbox full", "OUTBOX_STORAGE_UNAVAILABLE"])(
    "sends from memory when saving fails with %s",
    async (message) => {
      disk.save.mockImplementation(() => {
        throw new Error(message);
      });
      const attempt = feedback.sendAttempt(payload());
      expect(disk.forget).not.toHaveBeenCalled();
      await act(async () => {
        expect(await feedback.send(attempt)).toBe(true);
      });
      expect(request).toHaveBeenCalledWith("threads/send", expect.anything(), undefined, "space-a");
      expect(attempt.payload.attachments[0]?.contentBase64).toBe("fake");
      disk.save.mockImplementation(() => undefined);
      act(() => confirmEchoes("bot-1", [42]));
      expect(disk.forget).toHaveBeenCalledWith(attempt);
    },
  );
  it("retries attachments from memory when admission throws", async () => {
    disk.admit.mockImplementationOnce(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    request.mockRejectedValueOnce(new Error("Send interrupted"));
    const attempt = feedback.sendAttempt(payload());
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    expect(attempt.payload.attachments[0]?.contentBase64).toBe("fake");
    await act(async () => {
      expect(await feedback.send(attempt)).toBe(true);
    });
    expect(disk.hydrate).not.toHaveBeenCalled();
    expect(disk.save).toHaveBeenLastCalledWith([]);
  });
  it("deletes a delivered message's files only after the index without it is saved", async () => {
    const failed = feedback.sendAttempt(payload("First"));
    await act(async () => {
      await feedback.send(failed);
    });
    disk.save.mockImplementationOnce(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    act(() => confirmEchoes("bot-1", [42]));
    expect(disk.forget).not.toHaveBeenCalled();
    const saved = feedback.sendAttempt(payload("Second"));
    await act(async () => {
      await feedback.send(saved);
    });
    act(() => confirmEchoes("bot-1", [42]));
    expect(disk.forget).toHaveBeenCalledWith(saved);
    expect(disk.save.mock.lastCall).toEqual([[]]);
    expect(disk.save.mock.invocationCallOrder.at(-1)).toBeLessThan(
      disk.forget.mock.invocationCallOrder.at(-1)!,
    );
  });
  it("deletes a discarded message's files once a later save drops it", () => {
    const discarded = feedback.sendAttempt(payload("First"));
    disk.save.mockImplementationOnce(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    act(() => feedback.discard(discarded));
    expect(disk.forget).not.toHaveBeenCalled();
    // The leftover files fill the disk budget until they are deleted.
    disk.admit.mockImplementationOnce(() => disk.forget.mock.calls.length > 0);
    const saved = feedback.sendAttempt(payload("Second"));
    expect(disk.forget).toHaveBeenCalledWith(discarded);
    expect(disk.save).toHaveBeenLastCalledWith([saved]);
  });
  it("keeps a discarded message's files when it is sent again before they are deleted", async () => {
    const discarded = feedback.sendAttempt(payload());
    disk.save.mockImplementationOnce(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    act(() => feedback.discard(discarded));
    await act(async () => {
      await feedback.send(discarded);
    });
    expect(disk.forget).not.toHaveBeenCalled();
  });
  it.each(["Read failed", "OUTBOX_STORAGE_UNAVAILABLE"])(
    "finishes a failed restore (%s) without overwriting recoverable messages",
    async (message) => {
      act(() => clearFailedSends());
      vi.clearAllMocks();
      disk.load.mockImplementationOnce(() => {
        throw new Error(message);
      });
      act(() => restoreUnsentSends());
      const attempt = feedback.sendAttempt(payload());
      await act(async () => {
        expect(await feedback.send(attempt)).toBe(true);
      });
      expect(disk.save).not.toHaveBeenCalled();
      expect(disk.clear).not.toHaveBeenCalled();
      act(() => restoreUnsentSends());
      expect(disk.load).toHaveBeenCalledOnce();
    },
  );
  it("sends in a new session without loading discarded messages when clearing fails", async () => {
    const old = feedback.sendAttempt(payload("Old"));
    disk.load.mockReturnValueOnce([old]);
    vi.clearAllMocks();
    disk.clear.mockImplementation(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    act(() => clearFailedSends());
    act(() => restoreUnsentSends());
    const attempt = feedback.sendAttempt(payload("New"));
    await act(async () => {
      expect(await feedback.send(attempt)).toBe(true);
    });
    expect(disk.load).not.toHaveBeenCalled();
    expect(disk.admit).not.toHaveBeenCalled();
    expect(disk.save).not.toHaveBeenCalled();
    expect(
      request.mock.calls.filter(([proc]) => proc === "threads/send").map(([, body]) => body.text),
    ).toEqual(["New"]);
    disk.load.mockReset().mockReturnValue([]);
    disk.clear.mockImplementation(() => undefined);
    const saved = feedback.sendAttempt(payload());
    expect(disk.save).toHaveBeenLastCalledWith([saved]);
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
    expect(container.textContent).toContain("Not sent. Tap to retry");
    expect(disk.save).toHaveBeenLastCalledWith([first, second]);
    reachable = true;
    await act(async () => {
      await sendWaitingMessages();
    });
    expect(
      request.mock.calls.filter(([proc]) => proc === "threads/send").map(([, body]) => body.text),
    ).toEqual(["First", "Second"]);
  });
  const fileNote = "The bot can use the file but won't see the picture.";
  it("uploads distinct files after removal and reuses their artifacts on retry", async () => {
    const a = { name: "first.txt", mimeType: "text/plain", size: 4, contentBase64: "YWFhYQ==" };
    const b = { name: "same.txt", mimeType: "text/plain", size: 4, contentBase64: "YmJiYg==" };
    const c = { ...b, contentBase64: "Y2NjYw==" };
    const ids = vi.spyOn(core, "newClientId");
    ids.mockReturnValueOnce("a").mockReturnValueOnce("b").mockReturnValueOnce("c");
    const remaining = filterPickedAttachments(0, [a, b]).attachments.slice(1);
    const attachments = [
      ...remaining,
      ...filterPickedAttachments(remaining.length, [c]).attachments,
    ];
    ids.mockRestore();
    const sendPayload = { ...payload(), attachments };
    const attempt = feedback.sendAttempt(sendPayload);
    let sendsAttempted = 0;
    request.mockImplementation(async (proc, body) => {
      if (proc === "artifacts/create") {
        return { id: body.contentBase64 === b.contentBase64 ? "artifact-b" : "artifact-c" };
      }
      if (++sendsAttempted === 1) throw new Error("Send interrupted");
      return { seq: 42 };
    });

    await expect(
      deliverSend(sendPayload, attempt, request as unknown as typeof rpc),
    ).rejects.toThrow("Send interrupted");
    await deliverSend(sendPayload, attempt, request as unknown as typeof rpc);

    const uploads = request.mock.calls.filter(([proc]) => proc === "artifacts/create");
    expect(uploads.map(([, body]) => body.contentBase64)).toEqual([
      b.contentBase64,
      c.contentBase64,
    ]);
    const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.[1].artifactIds).toEqual(["artifact-b", "artifact-c"]);
    expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
  });
  it("retains an image rejection as retryable and reuses its uploaded artifact", async () => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(
        Object.assign(
          new Error("This model cannot read images. Choose a model that supports images."),
          { status: 409 },
        ),
      );
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    expect(attempt.payload.attachments).toHaveLength(1);
    expect(attempt.artifactIds.size).toBe(1);
    expect(container.textContent).toContain("Not sent. Tap to retry");
    await act(async () => {
      await feedback.send(attempt, true);
    });
    expect(attempt.acceptedSeq).toBe(42);
    expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(1);
    const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
  });
  it.each(["ios", "android"])(
    "offers explicit file confirmation on %s and reuses the original upload",
    async (os) => {
      Platform.OS = os as typeof Platform.OS;
      const attempt = feedback.sendAttempt(payload());
      request
        .mockResolvedValueOnce({ id: "artifact-a" })
        .mockRejectedValueOnce(
          Object.assign(
            new Error("This model cannot read images. Choose a model that supports images."),
            { status: 409, data: { reason: "model_image_input_unsupported" } },
          ),
        );
      await act(async () => {
        await feedback.send(attempt);
      });
      expect(attempt.imageConfirmation).toBe(true);
      expect(container.textContent).toContain("Not sent. Tap for options");
      act(() =>
        container
          .querySelector("button")!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );
      if (os === "ios") {
        const [options, choose] = vi
          .mocked(ActionSheetIOS.showActionSheetWithOptions)
          .mock.calls.at(-1)!;
        expect(options.options).toEqual(["Send as file", "Delete", "Cancel"]);
        expect(options.message).toContain(fileNote);
        await act(async () => {
          choose(0);
        });
      } else {
        const [, message, buttons] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
        expect(message).toContain(fileNote);
        expect(buttons!.map(({ text }) => text)).toEqual(["Send as file", "Delete", "Cancel"]);
        await act(async () => {
          buttons![0]!.onPress?.();
        });
      }
      expect(attempt.imageHandling).toBe("file");
      await act(async () => {
        await feedback.send(attempt, true);
      });
      const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
      expect(sends.at(-1)?.[1]).toEqual({ ...sends[0]?.[1], imageHandling: "file" });
      expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(1);
      Platform.OS = "ios";
    },
  );

  it.each(["ios", "android"])(
    "opens discoverable file and retry choices on tap (%s)",
    async (os) => {
      Platform.OS = os as typeof Platform.OS;
      const attempt = feedback.sendAttempt(payload());
      request.mockResolvedValueOnce({ id: "artifact-a" }).mockRejectedValueOnce(
        Object.assign(new Error("Image input is not configured for this model."), {
          status: 409,
          data: { reason: "model_image_input_unsupported" },
        }),
      );
      await act(async () => {
        await feedback.send(attempt);
      });
      act(() => container.querySelector("button")!.click());
      if (os === "ios") {
        const [options, choose] = vi
          .mocked(ActionSheetIOS.showActionSheetWithOptions)
          .mock.calls.at(-1)!;
        expect(options.options).toEqual(["Send as file", "Try Again", "Cancel"]);
        expect(options.message).toBe(
          `Image input is not configured for this model.\n\n${fileNote}`,
        );
        act(() => choose(1));
      } else {
        const [, message, buttons] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
        expect(message).toBe(`Image input is not configured for this model.\n\n${fileNote}`);
        expect(buttons!.map(({ text }) => text)).toEqual(["Send as file", "Try Again", "Cancel"]);
        act(() => buttons![1]!.onPress?.());
      }
      expect(retry).toHaveBeenCalledOnce();
      expect(attempt.imageHandling).toBeUndefined();
      Platform.OS = "ios";
    },
  );
  it("does not offer new confirmation for an older server's unstructured error", async () => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(Object.assign(new Error("Conflict"), { status: 409 }));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.imageConfirmation).toBe(false);
    expect(attempt.state).toBe("failed");
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
  it.each(["ios", "android"])(
    "offers Add Model instead of Try Again for missing-model failures on %s",
    async (os) => {
      Platform.OS = os as typeof Platform.OS;
      const attempt = feedback.sendAttempt(payload());
      request
        .mockResolvedValueOnce({ id: "artifact-a" })
        .mockRejectedValueOnce(
          Object.assign(new Error(MODEL_REQUIRED_SEND_ERROR), { status: 400 }),
        );
      await act(async () => {
        await feedback.send(attempt);
      });
      expect(attempt.state).toBe("failed");
      expect(container.textContent).toContain("Not sent. No model");
      expect(container.textContent).not.toContain("Tap to retry");
      act(() =>
        container
          .querySelector("button")!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );
      if (os === "ios") {
        const [options, choose] = vi
          .mocked(ActionSheetIOS.showActionSheetWithOptions)
          .mock.calls.at(-1)!;
        expect(options.options).toEqual(["Add Model", "Delete", "Cancel"]);
        expect(options.message).toBeUndefined();
        expect(options.cancelButtonIndex).toBe(2);
        expect(options.destructiveButtonIndex).toBe(1);
        act(() => choose(0));
        expect(router.push).toHaveBeenCalledWith("/(settings)/models");
      } else {
        const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!;
        expect(vi.mocked(Alert.alert).mock.calls.at(-1)![1]).toBeUndefined();
        expect(buttons.map(({ text }) => text)).toEqual(["Add Model", "Delete", "Cancel"]);
        expect(buttons[2]!.style).toBe("cancel");
        act(() => buttons[0]!.onPress?.());
        expect(router.push).toHaveBeenCalledWith("/(settings)/models");
      }
      expect(retry).not.toHaveBeenCalled();
      // Tapping the bubble is still the manual retry.
      act(() => container.querySelector("button")!.click());
      expect(retry).toHaveBeenCalledOnce();
      const calls = request.mock.calls.length;
      await act(async () => {
        await sendWaitingMessages(true);
      });
      expect(request).toHaveBeenCalledTimes(calls);
      await act(async () => {
        await feedback.send(attempt);
      });
      const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
      expect(sends).toHaveLength(2);
      expect(sends[1]).toEqual(sends[0]);
      Platform.OS = "ios";
    },
  );
  it.each(["ios", "android"])("keeps Try Again for other send failures on %s", async (os) => {
    Platform.OS = os as typeof Platform.OS;
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(new Error("Quota exceeded"));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    if (os === "ios") {
      const [options, choose] = vi
        .mocked(ActionSheetIOS.showActionSheetWithOptions)
        .mock.calls.at(-1)!;
      expect(options.options).toEqual(["Try Again", "Delete", "Cancel"]);
      expect(options.cancelButtonIndex).toBe(2);
      expect(options.destructiveButtonIndex).toBe(1);
      act(() => choose(0));
    } else {
      const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!;
      expect(buttons.map(({ text }) => text)).toEqual(["Try Again", "Delete", "Cancel"]);
      act(() => buttons[0]!.onPress?.());
    }
    expect(retry).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    Platform.OS = "ios";
  });
  it("offers retry for a missing-model failure once a model is connected", async () => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(Object.assign(new Error(MODEL_REQUIRED_SEND_ERROR), { status: 400 }));
    await act(async () => {
      await feedback.send(attempt);
    });
    needsModel = true;
    act(() => root.render(<Probe threadKey="bot-1" />));
    expect(container.textContent).toContain("Not sent. No model");
    expect(container.textContent).not.toContain("Tap to retry");
    needsModel = false;
    act(() => root.render(<Probe threadKey="bot-1" />));
    expect(container.textContent).toContain("Not sent. Tap to retry");
    expect(container.textContent).not.toContain("No model");
    act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    const [options, choose] = vi
      .mocked(ActionSheetIOS.showActionSheetWithOptions)
      .mock.calls.at(-1)!;
    expect(options.options).toEqual(["Try Again", "Delete", "Cancel"]);
    expect(options.message).toBeUndefined();
    act(() => choose(0));
    expect(retry).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    needsModel = undefined;
  });
  it("restores old missing-model rejections as manually retryable", async () => {
    const saved = feedback.sendAttempt(payload());
    act(() => clearFailedSends());
    const attempt = {
      ...saved,
      session: saved.session + 1,
      state: "refused" as const,
      error: MODEL_REQUIRED_SEND_ERROR,
    };
    disk.load.mockReturnValueOnce([attempt]);
    act(() => restoreUnsentSends());
    expect(attempt.state).toBe("failed");
    await sendWaitingMessages(true);
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps unrelated client rejections refused and inert on tap", async () => {
    const attempt = feedback.sendAttempt(payload());
    request.mockRejectedValueOnce(Object.assign(new Error("Rejected"), { status: 400 }));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("refused");
    expect(container.textContent).toContain("Not sent");
    act(() => container.querySelector("button")!.click());
    expect(router.push).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
  it.each([
    [409, "Stop teaching first"],
    [426, "Update required"],
  ])("keeps a %i rejection retryable", async (status, message) => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(Object.assign(new Error(message), { status }));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    expect(container.textContent).toContain("Not sent. Tap to retry");
    act(() => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => {
      await feedback.send(attempt, true);
    });
    expect(attempt.acceptedSeq).toBe(42);
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

describe("a send and its echo", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reachable = true;
  let chat: MobileSnapshot;
  /** What each render showed: the server's copies of the message and the unsent bubbles. */
  let frames: Array<{ echoed: number; bubbles: number }> = [];
  const request = vi.fn();
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    cacheSession: "ns-a",
    spaceId: "space-a",
  };
  const disk = {
    admit: () => true,
    hydrate: async () => undefined,
    forget: () => undefined,
    load: () => [],
    save: () => undefined,
    clear: () => undefined,
  };

  // Mirrors the thread screen: the server's messages, then the unsent sends below them.
  function Chat({ snapshot }: { snapshot: MobileSnapshot }) {
    const seqs = useMemo(
      () =>
        new Set(
          snapshot.messages.flatMap((message) =>
            message.role === "user" && message.seq !== undefined ? [message.seq] : [],
          ),
        ),
      [snapshot],
    );
    feedback = useThreadFeedback("bot-1", () => `nonce-${++nonces}`, seqs);
    const echoed = snapshot.messages.filter((message) => message.role === "user");
    frames.push({ echoed: echoed.length, bubbles: feedback.unsentSends.length });
    return (
      <>
        {echoed.map((message) => (
          <p key={message.id}>Hello</p>
        ))}
        {feedback.unsentSends.map((attempt) => (
          <FailedSendBubble
            key={attempt.clientNonce}
            attempt={attempt}
            onRetry={() => void feedback.send(attempt, true)}
            onDelete={() => feedback.discard(attempt)}
          />
        ))}
      </>
    );
  }
  function show(next: MobileSnapshot) {
    chat = next;
    act(() => root.render(<Chat snapshot={chat} />));
  }
  /** The live (or replayed) event for the stored message; its own event seq differs. */
  function echo(eventSeq = 9) {
    show(
      applyMobileThreadEvent(chat, {
        type: "thread.message.created",
        seq: eventSeq,
        payload: {
          messageId: "message-42",
          seq: 42,
          role: "user",
          blocks: [{ kind: "text", text: "Hello" }],
        },
      } as never)!,
    );
  }
  /** Holds the next threads/send open until the returned function accepts it. */
  function heldSend(): (value: { seq: number }) => Promise<void> {
    let accept: ((value: { seq: number }) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    return async (value) => {
      await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
      accept!(value);
    };
  }
  function textPayload(text = "Hello"): SendPayload {
    return {
      ...payload(text),
      replyPreview: null,
      plan: resolveComposerSendPlan({ text, mentions: [], hasAttachments: false }),
      attachments: [],
      replyTargetId: undefined,
      replyQuote: null,
    };
  }
  const copies = () => frames.at(-1)!.echoed + frames.at(-1)!.bubbles;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    clearFailedSends();
    reachable = true;
    frames = [];
    request.mockReset();
    request.mockResolvedValue({ seq: 42 });
    configureUnsentSends({
      request,
      scope: () => scope,
      serverReachable: () => reachable,
      disk,
      errorText: String,
      notDelivered: () => undefined,
    });
    restoreUnsentSends();
    container = document.createElement("div");
    root = createRoot(container);
    show({
      botId: "bot-1",
      threadId: "thread-1",
      cursor: 8,
      messages: [],
      olderCursor: null,
      run: null,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    clearFailedSends();
    vi.unstubAllGlobals();
  });

  it("swaps the sending bubble for the live echo in one render", async () => {
    const accept = heldSend();
    const attempt = feedback.sendAttempt(textPayload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    expect(container.textContent).toContain("Sending…");
    await act(async () => {
      await accept({ seq: 42 });
      await sending;
    });
    expect(frames.at(-1)).toEqual({ echoed: 0, bubbles: 1 });
    frames = [];
    echo();
    expect(frames.every((frame) => frame.echoed + frame.bubbles === 1)).toBe(true);
    expect(frames.at(-1)).toEqual({ echoed: 1, bubbles: 0 });
    expect(container.textContent).not.toContain("Sending…");
  });

  it("shows the message once when the echo arrives before threads/send resolves", async () => {
    const accept = heldSend();
    const attempt = feedback.sendAttempt(textPayload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    echo();
    frames = [];
    await act(async () => {
      await accept({ seq: 42 });
      await sending;
    });
    expect(frames.every((frame) => frame.echoed + frame.bubbles === 1)).toBe(true);
    expect(copies()).toBe(1);
    expect(container.textContent).not.toContain("Sending…");
  });

  it("shows a send held offline once when the reconnect replays its echo", async () => {
    reachable = false;
    const attempt = feedback.sendAttempt(textPayload());
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(container.textContent).toContain("Not sent. Tap to retry");
    reachable = true;
    await act(async () => {
      await sendWaitingMessages();
    });
    frames = [];
    // The resumed subscription replays the event, and a second reconnect replays it again.
    echo();
    echo();
    expect(frames.every((frame) => frame.echoed + frame.bubbles === 1)).toBe(true);
    expect(copies()).toBe(1);
  });

  it("keeps one failed bubble with Retry while other messages arrive", async () => {
    request.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }));
    const attempt = feedback.sendAttempt(textPayload());
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    show(
      applyMobileThreadEvent(chat, {
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "message-41", seq: 41, role: "bot", blocks: [] },
      } as never)!,
    );
    expect(frames.at(-1)).toEqual({ echoed: 0, bubbles: 1 });
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.textContent).toContain("Not sent. Tap to retry");
    await act(async () => {
      container.querySelector("button")!.click();
      await vi.waitFor(() => expect(attempt.acceptedSeq).toBe(42));
    });
    echo(10);
    expect(copies()).toBe(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
