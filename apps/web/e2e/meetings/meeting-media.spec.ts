import { expect, test } from "@playwright/test";
import { browserMeetingMediaEmulator } from "@rakazo/api/test-meeting-media";
import { deferred } from "@rakazo/core/test-async";
import { captureScreenshot } from "../helpers/helpers";

type MeetingAudioProbe = typeof window & {
  inputFrames: number;
  playbackStarted: number;
  playbackStopped: number;
  speak?: (volume?: number) => void;
  workletReady?: boolean;
};

const mediaTest = test.extend<{ media: Awaited<ReturnType<typeof browserMeetingMediaEmulator>> }>({
  media: async ({ page: _page }, use) => {
    const emulator = await browserMeetingMediaEmulator();
    try {
      await use(emulator);
    } finally {
      emulator.close();
    }
  },
});

mediaTest.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

mediaTest(
  "the branded meeting page captures audio, plays a reply and interrupts it",
  async ({ page, media }, testInfo) => {
    await page.addInitScript(() => {
      const probe = window as MeetingAudioProbe;
      probe.inputFrames = 0;
      probe.playbackStarted = 0;
      probe.playbackStopped = 0;
      window.AudioWorkletNode = class extends AudioWorkletNode {
        constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
          super(...args);
          probe.workletReady = true;
          this.port.addEventListener("message", () => {
            probe.inputFrames++;
          });
        }
      };
      const { start, stop } = AudioBufferSourceNode.prototype;
      AudioBufferSourceNode.prototype.start = function (...args) {
        probe.playbackStarted++;
        return start.apply(this, args);
      };
      AudioBufferSourceNode.prototype.stop = function (...args) {
        probe.playbackStopped++;
        return stop.apply(this, args);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const microphone = context.createMediaStreamDestination();
        const gain = context.createGain();
        const sound = context.createOscillator();
        gain.gain.value = 0;
        sound.connect(gain).connect(microphone);
        sound.start();
        await context.resume();
        probe.speak = (volume = 0.2) => {
          const present = context.currentTime;
          gain.gain.setValueAtTime(volume, present);
          gain.gain.setValueAtTime(0, present + 0.52);
        };
        return microphone.stream;
      };
    });

    await page.goto(media.url());
    await expect(page.getByRole("heading", { name: "Atlas · Rakazo" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Rakazo" })).toBeVisible();

    const restored = page.waitForEvent("load");
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await restored;
    await expect(page.getByRole("heading", { name: "Atlas · Rakazo" })).toBeVisible();
    await page.waitForFunction(() => (window as MeetingAudioProbe).workletReady === true);
    const firstReply = page.waitForResponse(
      (response) => response.url().endsWith("/turn") && response.status() === 200,
    );
    await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
    await page.waitForFunction(
      () => (window as MeetingAudioProbe).playbackStarted === 1,
      {},
      { timeout: 9_000 },
    );
    const audio = Buffer.from(media.received[0] ?? []);
    expect(audio.readUInt32LE(24)).toBe(16_000);
    expect(audio.subarray(44).some((byte) => byte > 0)).toBe(true);
    await captureScreenshot(page, testInfo, "meeting-agent-branded-tile");

    media.setSilent(true);
    const silence = page.waitForResponse(
      (response) => response.url().endsWith("/turn") && response.status() === 204,
    );
    await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
    await page.waitForFunction(() => (window as MeetingAudioProbe).playbackStopped === 1);
    const first = await firstReply;
    const afterInterruption = await silence;
    expect(afterInterruption.request().headers()["x-meeting-context"]).toBe(
      first.headers()["x-meeting-context"],
    );
    expect(await page.evaluate(() => (window as MeetingAudioProbe).playbackStarted)).toBe(1);

    const reply = deferred<void>();
    const ready = deferred<void>();
    media.beforeReply(async () => {
      ready.resolve();
      await reply.promise;
    });
    const responses = Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith("/turn") && response.status() === 204,
      ),
      page.waitForRequest(
        (request) => request.url().endsWith("/turn") && media.received.length === 3,
      ),
    ]);
    await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
    await ready.promise;
    try {
      for (const volume of [0.12, 0.28]) {
        const startedAtFrame = await page.evaluate((volume) => {
          const channel = window as MeetingAudioProbe;
          channel.speak?.(volume);
          return channel.inputFrames;
        }, volume);
        // Each tone and its trailing silence take fewer than twenty worklet frames.
        await page.waitForFunction(
          (target) => (window as MeetingAudioProbe).inputFrames >= target,
          startedAtFrame + 20,
        );
        expect(media.received).toHaveLength(3);
      }
    } finally {
      reply.resolve();
    }
    await responses;
    await expect.poll(() => media.received.length).toBe(4);
    const queuedPeaks = voicedPeaks(Buffer.from(media.received[3] ?? []));
    expect(queuedPeaks).toHaveLength(2);
    expect(queuedPeaks[0]).toBeGreaterThan(3_000);
    expect(queuedPeaks[1]).toBeGreaterThan(queuedPeaks[0]! * 2);

    media.revoke();
    const revoked = page.waitForResponse(
      (response) => response.url().endsWith("/turn") && response.status() === 401,
    );
    await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
    await revoked;
    expect(media.received).toHaveLength(4);
  },
);

// The worklet emits 1,024 mono samples per frame. The two fixture tones have
// distinct peak magnitudes and a full gap, so PCM establishes their order.
function voicedPeaks(wav: Buffer) {
  const peaks: number[] = [];
  let peak = 0;
  for (let offset = 44; offset + 2_048 <= wav.length; offset += 2_048) {
    let framePeak = 0;
    for (let sample = offset; sample < offset + 2_048; sample += 2) {
      framePeak = Math.max(framePeak, Math.abs(wav.readInt16LE(sample)));
    }
    if (framePeak < 1_000) {
      if (peak) peaks.push(peak);
      peak = 0;
    } else {
      peak = Math.max(peak, framePeak);
    }
  }
  if (peak) peaks.push(peak);
  return peaks;
}
