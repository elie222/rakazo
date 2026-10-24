import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("pasting into the composer attaches images and inserts text", async ({
  page,
  context,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `composer-paste-${stamp}@rakazo.test`, "password12", "Paste Test");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();

  // Plain text still pastes as text.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("pasted words"));
  await composer.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(composer).toHaveValue("pasted words");
  await composer.fill("");

  // An image becomes an attachment.
  await page.evaluate(async () => {
    const target = document.querySelector("textarea[name='chat-message']");
    if (!target) throw new Error("composer textarea not found");
    const canvas = document.createElement("canvas");
    canvas.width = 3200;
    canvas.height = 2400;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("PNG encoding failed"))),
        "image/png",
      ),
    );
    // Trailing padding exercises admission above the default upload limit.
    const file = new File([blob, new Uint8Array(11 * 1024 * 1024)], "paste.png", {
      type: "image/png",
    });
    const clipboardData = {
      files: [file],
      types: ["Files"],
      items: [{ kind: "file" }],
      getData: () => "",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    target.dispatchEvent(event);
  });
  await expect(page.getByRole("button", { name: "Remove paste.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-paste-attachment");

  // An image with text keeps the attachment and inserts the text.
  await page.evaluate(() => {
    const target = document.querySelector("textarea[name='chat-message']");
    if (!(target instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "mixed.png", { type: "image/png" });
    const clipboardData = {
      files: [file],
      types: ["Files", "text/plain"],
      items: [{ kind: "file" }, { kind: "string" }],
      getData: (type: string) => (type === "text/plain" ? "caption text" : ""),
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    target.dispatchEvent(event);
  });
  await expect(page.getByRole("button", { name: "Remove mixed.png" })).toBeVisible();
  await expect(composer).toHaveValue("caption text");

  // Inspect the actual upload, exercising browser decoding and canvas encoding.
  await page.route("**/rpc/artifacts/create", (route) => route.abort());
  const upload = page.waitForRequest("**/rpc/artifacts/create");
  await composer.press("Enter");
  const payload = (await upload).postDataJSON().json;
  expect(payload.name).toBe("paste.png");
  expect(payload.mimeType).toBe("image/png");
  const dimensions = await page.evaluate(async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const dimensions = [image.width, image.height];
    image.close();
    return dimensions;
  }, payload.contentBase64);
  expect(dimensions).toEqual([1600, 1200]);
});
