import { expect, test } from "@playwright/test";
import { browserMeetingMediaEmulator } from "../../../api/src/meetings/media/meeting-media.test-support";
import { captureScreenshot } from "../helpers/helpers";

type MeetingAudioProbe = typeof window & {
  playbackStarted: number;
  playbackStopped: number;
  speak?: () => void;
};

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("the branded meeting page captures audio, plays a reply and interrupts it", async ({
  page,
}, testInfo) => {
  const origin = "http://127.0.0.1:55249";
  const emulator = browserMeetingMediaEmulator(origin);
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const bytes = request.postDataBuffer();
    const response = await emulator.fetch(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      body: bytes ? new Uint8Array(bytes) : null,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.addInitScript(() => {
    const probe = window as MeetingAudioProbe;
    probe.playbackStarted = 0;
    probe.playbackStopped = 0;
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

  await page.goto(emulator.url());
  await expect(page.getByRole("heading", { name: "Atlas · Rakazo" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Rakazo" })).toBeVisible();
  await page.waitForFunction(() => typeof (window as MeetingAudioProbe).speak === "function");
  await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
  await page.waitForFunction(() => (window as MeetingAudioProbe).playbackStarted === 1);
  const audio = Buffer.from(emulator.received[0] ?? []);
  expect(audio.readUInt32LE(24)).toBe(16_000);
  expect(audio.subarray(44).some((byte) => byte > 0)).toBe(true);
  await captureScreenshot(page, testInfo, "meeting-agent-branded-tile");

  emulator.setSilent(true);
  const silence = page.waitForResponse(
    (response) => response.url().endsWith("/turn") && response.status() === 204,
  );
  await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
  await page.waitForFunction(() => (window as MeetingAudioProbe).playbackStopped === 1);
  await silence;
  expect(await page.evaluate(() => (window as MeetingAudioProbe).playbackStarted)).toBe(1);

  emulator.revoke();
  const revoked = page.waitForResponse(
    (response) => response.url().endsWith("/turn") && response.status() === 401,
  );
  await page.evaluate(() => (window as MeetingAudioProbe).speak?.());
  await revoked;
  expect(emulator.received).toHaveLength(2);
});
