import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dictation from "./dictation";
import * as onDeviceSpeech from "./on-device-speech";
import * as serverDictation from "./server-dictation";
import type { VoiceChatDeps, VoiceChatDictationHandlers } from "./voice-chat";
import { createVoiceChatSession, productionVoiceChatDeps, voiceChatOrbVariant } from "./voice-chat";

vi.mock("./i18n", () => ({
  t: (text: string) => text,
  deviceLanguage: async () => "en-US",
  getActiveUiLocale: () => "en",
}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./api-live", () => ({ subscribeThread: vi.fn() }));
vi.mock("./dictation", () => ({
  available: vi.fn(async () => true),
  listen: vi.fn(),
  finish: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./on-device-speech", () => ({
  onDeviceSpeechAvailable: vi.fn(async () => false),
  listenOnDeviceSpeech: vi.fn(),
  finishOnDeviceSpeech: vi.fn(),
  stopOnDeviceSpeech: vi.fn(),
}));
vi.mock("./server-dictation", () => ({
  serverTranscribeAvailable: vi.fn(async () => false),
  listenServerDictation: vi.fn(),
  finishServerDictation: vi.fn(),
  stopServerDictation: vi.fn(),
}));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("voice-chat-test"),
  speakText: vi.fn(async () => true),
  stopSpeaking: vi.fn(),
}));

function fakeDeps() {
  let handlers: VoiceChatDictationHandlers | null = null;
  let lastHeard = "";
  let replyListener: ((messageId: string, text: string) => void) | null = null;
  let lostListener: (() => void) | null = null;
  const unwatch = vi.fn();
  const deps: VoiceChatDeps = {
    dictate: vi.fn(async (next: VoiceChatDictationHandlers) => {
      handlers = next;
      return true;
    }),
    finishDictation: vi.fn(() => {
      handlers?.onFinal(lastHeard);
    }),
    stopDictation: vi.fn(),
    send: vi.fn(async () => "run-1"),
    watch: vi.fn(
      (_botId: string, onReply: (messageId: string, text: string) => void, onLost: () => void) => {
        replyListener = onReply;
        lostListener = onLost;
        return unwatch;
      },
    ),
    speak: vi.fn(async () => true),
    stopSpeaking: vi.fn(),
  };
  return {
    deps,
    unwatch,
    hear: (text: string) => {
      lastHeard = text;
      handlers?.onInterim(text);
    },
    giveUp: (reason: "idle" | "failed") => handlers?.onGiveUp(reason),
    reply: (messageId: string, text: string) => replyListener?.(messageId, text),
    loseWatch: () => lostListener?.(),
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("voiceChatOrbVariant", () => {
  it("waits while idle, thinking, or listening in silence", () => {
    expect(voiceChatOrbVariant("idle", "")).toBe("waiting");
    expect(voiceChatOrbVariant("thinking", "")).toBe("waiting");
    expect(voiceChatOrbVariant("listening", "")).toBe("waiting");
    expect(voiceChatOrbVariant("listening", "  ")).toBe("waiting");
    expect(voiceChatOrbVariant("not-ready", "")).toBe("waiting");
  });

  it("shows the caller while their words are coming in", () => {
    expect(voiceChatOrbVariant("listening", "你好")).toBe("user");
  });

  it("shows the AI while its reply is playing", () => {
    expect(voiceChatOrbVariant("speaking", "")).toBe("ai");
  });
});

describe("mobile voice chat", () => {
  it("sends the heard turn on release and speaks the reply", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    expect(fake.deps.watch).toHaveBeenCalledWith(
      "bot-1",
      expect.any(Function),
      expect.any(Function),
    );

    session.pressToTalk();
    await flush();
    expect(session.getState().phase).toBe("listening");
    expect(fake.deps.dictate).toHaveBeenCalledOnce();

    fake.hear("你好");
    expect(session.getState().heard).toBe("你好");
    session.releaseToSend();
    expect(fake.deps.finishDictation).toHaveBeenCalledOnce();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "你好");
    expect(session.getState().phase).toBe("thinking");
    expect(session.getState().exchanges).toEqual([{ role: "user", text: "你好" }]);

    fake.reply("m1", "你好呀");
    await flush();
    expect(fake.deps.speak).toHaveBeenCalledWith("bot-1", "你好呀");
    expect(session.getState().phase).toBe("idle");
    expect(session.getState().exchanges).toEqual([
      { role: "user", text: "你好" },
      { role: "bot", text: "你好呀", messageId: "m1" },
    ]);
  });

  it("sends the heard text even when the recognizer already ended", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();

    fake.hear("在吗");
    vi.mocked(fake.deps.finishDictation).mockImplementationOnce(() => undefined);
    session.releaseToSend();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "在吗");
  });

  it("closes the microphone without sending when nothing was heard", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();

    session.releaseToSend();
    expect(fake.deps.finishDictation).not.toHaveBeenCalled();
    expect(fake.deps.stopDictation).toHaveBeenCalled();
    expect(fake.deps.send).not.toHaveBeenCalled();
    expect(session.getState().phase).toBe("idle");
  });

  it("says plainly when speech recognition is unavailable instead of failing silently", async () => {
    const fake = fakeDeps();
    vi.mocked(fake.deps.dictate).mockResolvedValueOnce(false);
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();

    expect(session.getState().phase).toBe("not-ready");
    expect(session.getState().notice).toBe(
      "Allow speech recognition in Settings, or connect a voice provider in Voice settings.",
    );
    expect(fake.deps.send).not.toHaveBeenCalled();
  });

  it("says plainly when recognition gives up with a fatal error", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();

    fake.giveUp("failed");
    expect(session.getState().phase).toBe("not-ready");
    expect(session.getState().notice).toContain("Allow speech recognition");
  });

  it("cuts the reply off when the caller holds the microphone over it", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("你好");
    session.releaseToSend();
    fake.reply("m1", "你好呀");
    expect(session.getState().phase).toBe("speaking");

    session.pressToTalk();
    expect(fake.deps.stopSpeaking).toHaveBeenCalled();
    expect(session.getState().phase).toBe("listening");
  });

  it("hanging up stops the microphone and the speaker and ignores late replies", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("你好");
    session.releaseToSend();
    fake.reply("m1", "你好呀");

    session.end();
    expect(fake.deps.stopDictation).toHaveBeenCalled();
    expect(fake.deps.stopSpeaking).toHaveBeenCalled();
    expect(fake.unwatch).toHaveBeenCalled();
    expect(session.getState().phase).toBe("idle");

    vi.mocked(fake.deps.speak).mockClear();
    fake.reply("m2", "迟到的回复");
    await flush();
    expect(fake.deps.speak).not.toHaveBeenCalled();
    expect(session.getState().exchanges).toEqual([
      { role: "user", text: "你好" },
      { role: "bot", text: "你好呀", messageId: "m1" },
    ]);
  });

  it("re-sends the last user turn for regenerate without duplicating the bubble", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("讲个笑话");
    session.releaseToSend();
    fake.reply("m1", "笑话一则");
    await flush();
    vi.mocked(fake.deps.send).mockClear();

    session.resendLastUserTurn();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "讲个笑话");
    expect(session.getState().exchanges).toEqual([
      { role: "user", text: "讲个笑话" },
      { role: "bot", text: "笑话一则", messageId: "m1" },
    ]);
  });

  it("reads the latest reply aloud again on request", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("你好");
    session.releaseToSend();
    fake.reply("m1", "你好呀");
    await flush();
    vi.mocked(fake.deps.speak).mockClear();

    session.speakLastReply();
    await flush();
    expect(fake.deps.speak).toHaveBeenCalledWith("bot-1", "你好呀");
    expect(session.getState().phase).toBe("idle");
  });

  it("attaches a picked scenario's instruction to the next turn only, and never shows it", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setScenario("interview");
    expect(session.getState().scenarioId).toBe("interview");

    session.pressToTalk();
    await flush();
    fake.hear("我叫小明");
    session.releaseToSend();
    expect(fake.deps.send).toHaveBeenCalledWith(
      "bot-1",
      expect.stringContaining("【情景：面试练习】"),
    );
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", expect.stringContaining("我叫小明"));
    expect(session.getState().exchanges).toEqual([{ role: "user", text: "我叫小明" }]);

    fake.reply("m1", "请先自我介绍");
    await flush();
    vi.mocked(fake.deps.send).mockClear();
    session.pressToTalk();
    await flush();
    fake.hear("我有三年经验");
    session.releaseToSend();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "我有三年经验");
  });

  it("attaches nothing for the default scenario", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("你好");
    session.releaseToSend();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "你好");
  });

  it("falls back to the default scenario for an unknown id", () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setScenario("nope");
    expect(session.getState().scenarioId).toBe("daily");
  });

  it("drops to idle with a hint when the reply feed ends mid-turn", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.pressToTalk();
    await flush();
    fake.hear("你好");
    session.releaseToSend();
    expect(session.getState().phase).toBe("thinking");

    fake.loseWatch();
    expect(session.getState().phase).toBe("idle");
    expect(session.getState().notice).toBe("The connection dropped. Try again.");
  });
});

describe("hands-free voice chat", () => {
  it("opens the microphone on switch-on and reopens it after a reply", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");

    session.setHandsFree(true);
    await flush();
    expect(session.getState().handsFree).toBe(true);
    expect(session.getState().phase).toBe("listening");
    expect(fake.deps.dictate).toHaveBeenCalledOnce();

    fake.hear("你好");
    session.releaseToSend();
    expect(fake.deps.send).toHaveBeenCalledWith("bot-1", "你好");
    fake.reply("m1", "你好呀");
    await flush();
    expect(fake.deps.speak).toHaveBeenCalledWith("bot-1", "你好呀");
    expect(session.getState().phase).toBe("listening");
    expect(fake.deps.dictate).toHaveBeenCalledTimes(2);
  });

  it("reopens the microphone after silence instead of going idle", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setHandsFree(true);
    await flush();
    expect(fake.deps.dictate).toHaveBeenCalledOnce();

    fake.giveUp("idle");
    expect(session.getState().phase).toBe("listening");
    expect(fake.deps.dictate).toHaveBeenCalledTimes(2);
  });

  it("switching hands-free off stops the microphone", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setHandsFree(true);
    await flush();
    expect(session.getState().phase).toBe("listening");

    session.setHandsFree(false);
    expect(session.getState().handsFree).toBe(false);
    expect(session.getState().phase).toBe("idle");
    expect(fake.deps.stopDictation).toHaveBeenCalled();
  });

  it("a dead microphone switches hands-free off instead of retrying", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    vi.mocked(fake.deps.dictate).mockResolvedValueOnce(false);

    session.setHandsFree(true);
    await flush();
    expect(session.getState().phase).toBe("not-ready");
    expect(session.getState().handsFree).toBe(false);
    expect(fake.deps.dictate).toHaveBeenCalledOnce();
  });

  it("a failed recognizer switches hands-free off", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setHandsFree(true);
    await flush();

    fake.giveUp("failed");
    expect(session.getState().phase).toBe("not-ready");
    expect(session.getState().handsFree).toBe(false);
  });

  it("ending the session switches hands-free off", async () => {
    const fake = fakeDeps();
    const session = createVoiceChatSession(fake.deps);
    session.start("bot-1", "小智");
    session.setHandsFree(true);
    await flush();
    expect(session.getState().phase).toBe("listening");

    session.end();
    expect(session.getState().handsFree).toBe(false);
    expect(session.getState().phase).toBe("idle");
  });
});

describe("production voice chat dictation", () => {
  const handlers = {
    onInterim: () => undefined,
    onFinal: () => undefined,
    onGiveUp: () => undefined,
  };
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses on-device recognition when the device has it", async () => {
    vi.mocked(dictation.available).mockResolvedValueOnce(true);
    const started = await productionVoiceChatDeps().dictate(handlers, signal);
    expect(started).toBe(true);
    expect(dictation.listen).toHaveBeenCalledOnce();
    expect(serverDictation.listenServerDictation).not.toHaveBeenCalled();
  });

  it("prefers on-device speech over system recognition", async () => {
    vi.mocked(onDeviceSpeech.onDeviceSpeechAvailable).mockResolvedValueOnce(true);
    const started = await productionVoiceChatDeps().dictate(handlers, signal);
    expect(started).toBe(true);
    expect(onDeviceSpeech.listenOnDeviceSpeech).toHaveBeenCalledOnce();
    expect(dictation.listen).not.toHaveBeenCalled();
    expect(serverDictation.listenServerDictation).not.toHaveBeenCalled();
  });

  it("falls back to system recognition when on-device speech is off", async () => {
    vi.mocked(onDeviceSpeech.onDeviceSpeechAvailable).mockResolvedValueOnce(false);
    vi.mocked(dictation.available).mockResolvedValueOnce(true);
    const started = await productionVoiceChatDeps().dictate(handlers, signal);
    expect(started).toBe(true);
    expect(onDeviceSpeech.listenOnDeviceSpeech).not.toHaveBeenCalled();
    expect(dictation.listen).toHaveBeenCalledOnce();
  });

  it("falls back to server transcription when the device has no recognition", async () => {
    vi.mocked(dictation.available).mockResolvedValueOnce(false);
    vi.mocked(serverDictation.serverTranscribeAvailable).mockResolvedValueOnce(true);
    const started = await productionVoiceChatDeps().dictate(handlers, signal);
    expect(started).toBe(true);
    expect(dictation.listen).not.toHaveBeenCalled();
    expect(serverDictation.listenServerDictation).toHaveBeenCalledOnce();
  });

  it("reports not ready when neither recognition path exists", async () => {
    vi.mocked(dictation.available).mockResolvedValueOnce(false);
    vi.mocked(serverDictation.serverTranscribeAvailable).mockResolvedValueOnce(false);
    const started = await productionVoiceChatDeps().dictate(handlers, signal);
    expect(started).toBe(false);
    expect(dictation.listen).not.toHaveBeenCalled();
    expect(serverDictation.listenServerDictation).not.toHaveBeenCalled();
  });
});
