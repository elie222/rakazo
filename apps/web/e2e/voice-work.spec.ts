import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a spoken request executes computer tools and reads the result", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    class Recognition {
      continuous = true;
      interimResults = true;
      lang = "en-US";
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { voiceRecognition: Recognition }).voiceRecognition = this;
      }
      stop() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: Recognition });
  });
  await signup(page, `voice-work-${Date.now()}@rakazo.test`, "password12", "Voice Work");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-scripted-voice-key" });
  // Browser recognition is deterministic here; recorder/STT selection has separate unit coverage.
  await page.route("**/rpc/voice/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          configured: true,
          ready: true,
          transcribe: false,
          provider: "scripted",
          voiceId: "scripted",
        },
      }),
    }),
  );
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Call", exact: true }).click();
  const call = page.getByTestId("call-view");
  await expect(call.locator('[data-slot="fluid-orb"]')).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-fluid-voice-orb");
  const send = page.waitForRequest((request) => request.url().endsWith("/rpc/threads/send"));
  const spoken: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/voice/speak")) spoken.push(request.postDataJSON().text);
  });
  await page.evaluate(() => {
    const rec = (window as unknown as { voiceRecognition: { onresult: (event: unknown) => void } })
      .voiceRecognition;
    rec.onresult({
      resultIndex: 0,
      results: [[{ transcript: "Use your screen and type voiceproof" }]],
    });
  });
  expect((await send).postDataJSON().json.text).toBe("Use your screen and type voiceproof");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
        const message = snapshot.messages.at(-1);
        return (
          !snapshot.run &&
          message?.role === "bot" &&
          message.blocks.some(
            (block) => block.kind === "text" && block.text.includes("using my screen now"),
          )
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const completed = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  const tools = await page.evaluate(
    async ({ botId, runId }) => {
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 15_000);
      const names: string[] = [];
      try {
        const response = await fetch("/rpc/threads/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId, cursor: -1 } }),
          signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error("Thread event replay unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (names.length < 2) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)).json;
            if (
              event.runId === runId &&
              event.type === "agent.tool.called" &&
              ["computer_observe", "computer_act"].includes(event.payload.name)
            ) {
              if (!names.includes(event.payload.name)) names.push(event.payload.name);
            }
          }
        }
        return names;
      } finally {
        clearTimeout(deadline);
        abort.abort();
      }
    },
    { botId, runId: completed.messages.at(-1)?.runId },
  );
  expect(tools).toEqual(expect.arrayContaining(["computer_observe", "computer_act"]));
  await expect
    .poll(() => spoken.some((text) => text.includes("using my screen now")), { timeout: 30_000 })
    .toBe(true);
  await expect(call.getByRole("status")).toHaveText("Listening…", { timeout: 30_000 });
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await expect(call).toHaveCount(0);
  await expect(
    page.getByTestId("transcript").getByText("using my screen now.", { exact: true }),
  ).toBeVisible();
});
