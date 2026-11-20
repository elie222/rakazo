// The seeded account sends Chief a message and sees the reply, which survives a reload.
export default async function ({ page, expect, capture, signIn }) {
  await signIn();
  const composer = page.getByPlaceholder("Message Chief");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const text = `verify ping ${Date.now()}`;
  await composer.fill(text);
  await capture("typed");
  await page.keyboard.press("Enter");
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  // The offline scripted model echoes an ordinary message back.
  const reply = page.getByRole("paragraph").filter({ hasText: `done. i handled: ${text}` });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await capture("replied");
  await page.reload();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await capture("after-reload");
}
