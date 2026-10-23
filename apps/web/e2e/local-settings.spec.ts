import { expect, test } from "@playwright/test";

test("the retired local settings capability cannot access account models", async ({ request }) => {
  for (const procedure of ["me", "models/list", "models/connect", "integrationSetup/save"]) {
    const response = await request.post(`/api/desktop-settings/rpc/${procedure}`, {
      data: { json: {} },
    });
    expect(response.status()).toBe(403);
  }
});
