import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("the chat header floats over the transcript", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `chat-header-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });

  const composer = page.getByRole("combobox", { name: /Message/ });
  const transcript = page.getByTestId("transcript");
  for (let item = 1; item <= 8; item++) {
    const text = `Question ${item}: what is the status of launch item ${item}? The draft is reviewed and the checklist is complete.`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(transcript.getByText(text, { exact: true })).toBeVisible();
  }

  const fade = page.getByTestId("chat-top-fade");
  await expect(fade).toBeVisible();
  const layout = await page.evaluate(() => {
    const fadeElement = document.querySelector('[data-testid="chat-top-fade"]');
    const transcriptElement = document.querySelector('[data-testid="transcript"]');
    const headerElement = document.querySelector('[data-testid="chat-header"]');
    if (!fadeElement || !transcriptElement || !headerElement) {
      throw new Error("missing chat layout");
    }
    const fadeRect = fadeElement.getBoundingClientRect();
    const transcriptRect = transcriptElement.getBoundingClientRect();
    return {
      fadeHeight: fadeRect.height,
      fadeTop: fadeRect.top,
      fadeLeft: fadeRect.left,
      fadeWidth: fadeRect.width,
      transcriptPadding: Number.parseFloat(getComputedStyle(transcriptElement).paddingTop),
      transcriptScrollPadding: Number.parseFloat(
        getComputedStyle(transcriptElement).scrollPaddingTop,
      ),
      transcriptTop: transcriptRect.top,
      transcriptLeft: transcriptRect.left,
      transcriptWidth: transcriptRect.width,
      fadeZ: getComputedStyle(fadeElement).zIndex,
      headerZ: getComputedStyle(headerElement).zIndex,
    };
  });
  // The fade is the transcript's top clearance, so it is invisible while the chat is at the top.
  expect(layout.transcriptPadding).toBe(84);
  expect(layout.transcriptScrollPadding).toBe(layout.transcriptPadding);
  expect(Math.abs(layout.fadeHeight - layout.transcriptPadding)).toBeLessThanOrEqual(1);
  expect(layout.fadeTop).toBe(layout.transcriptTop);
  expect(layout.fadeLeft).toBe(layout.transcriptLeft);
  expect(Math.abs(layout.fadeWidth - layout.transcriptWidth)).toBeLessThanOrEqual(1);
  // The header stays above the fade, so its pills never blur.
  expect(Number(layout.headerZ)).toBeGreaterThan(Number(layout.fadeZ));

  const effect = await fade.evaluate((element) => {
    const before = getComputedStyle(element, "::before");
    return { filter: before.backdropFilter, mask: before.maskImage };
  });
  expect(effect.filter).toContain("blur(20px)");
  expect(effect.mask).toContain("linear-gradient");

  const header = await page.getByTestId("bot-settings-trigger").boundingBox();
  const scroller = await transcript.boundingBox();
  if (!header || !scroller) throw new Error("missing chat layout");
  // Messages scroll under the floating header rather than stopping below a bar.
  expect(scroller.y).toBeLessThan(header.y);
  const gapHitsTranscript = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="transcript"]')),
    { x: scroller.x + scroller.width / 4, y: header.y + header.height / 2 },
  );
  expect(gapHitsTranscript).toBe(true);

  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `chat-header-floating-${theme}`);
  }

  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = await transcript
    .getByText(/^Question 1:/)
    .first()
    .boundingBox();
  if (!first) throw new Error("missing first message");
  const fadeBox = await fade.boundingBox();
  if (!fadeBox) throw new Error("missing chat fade");
  expect(first.y).toBeGreaterThanOrEqual(fadeBox.y + fadeBox.height - 1);

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `chat-header-rest-${theme}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => {
    const transcriptElement = document.querySelector('[data-testid="transcript"]');
    const fadeElement = document.querySelector('[data-testid="chat-top-fade"]');
    if (!transcriptElement || !fadeElement) throw new Error("missing chat layout");
    return {
      padding: Number.parseFloat(getComputedStyle(transcriptElement).paddingTop),
      scrollPadding: Number.parseFloat(getComputedStyle(transcriptElement).scrollPaddingTop),
      fadeHeight: fadeElement.getBoundingClientRect().height,
    };
  });
  expect(narrow.padding).toBe(80);
  expect(narrow.scrollPadding).toBe(narrow.padding);
  expect(narrow.fadeHeight).toBe(80);
});
