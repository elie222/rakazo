import { expect, test } from "@playwright/test";
import { browserMeetingMediaEmulator } from "@rakazo/api/test-meeting-media";
import { captureScreenshot } from "../helpers/helpers";

type MeetingAudioProbe = typeof window & {
  playbackStarted: number;
  playbackStopped: number;
  speak?: () => void;
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
      probe.playbackStarted = 0;
      probe.playbackStopped = 0;
      window.AudioWorkletNode = class extends AudioWorkletNode {
        constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
          super(...args);
          probe.workletReady = true;
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
        probe.speak = () => {
          const present = context.currentTime;
          gain.gain.setValueAtTime(0.2, present);
          gain.gain.setValueAtTime(0, present + 0.52);
        };
        return microphone.stream;
      };
    });

    await page.goto(media.url());
    await expect(page.getByRole("heading", { name: "Atlas · Rakazo" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Rakazo" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Atlas · Rakazo" })).toBeVisible();
    await page.waitForFunction(() => (window as MeetingAudioProbe).workletReady === true);
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
    await silence;
    expect(await page.evaluate(() => (window as MeetingAudioProbe).playbackStarted)).toBe(1);

    media.revoke();
    const revoked = page.waitForResponse(
      (response) => response.url().endsWith("/turn") && response.status() === 401,
    );
    await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
    await revoked;
    expect(media.received).toHaveLength(2);
  },
);
