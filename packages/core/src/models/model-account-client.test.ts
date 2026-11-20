import { expect, it, vi } from "vitest";
import { createModelAccountClient, ModelAccountClientError } from "./model-account-client.js";

it("preserves structured recovery errors without exposing upstream details", async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ error: "link_required", detail: "private upstream detail" }, { status: 403 }),
  );
  const client = createModelAccountClient(transport);
  const error = await client.connect().catch((error) => error);
  expect(error).toBeInstanceOf(ModelAccountClientError);
  expect(error.code).toBe("link_required");
  expect(String(error)).not.toContain("private");
});

it("treats a lost write response as unknown and never automatically repeats it", async () => {
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("network");
  });
  await expect(createModelAccountClient(transport).revoke()).rejects.toMatchObject({
    code: "result_unknown",
  });
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(createModelAccountClient(transport).balance()).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("retains server-side recovery state and exact balances", async () => {
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("status")
      ? Response.json({
          enabled: true,
          connected: false,
          linked: true,
          recovery: "revocation_unknown",
        })
      : Response.json({ amount: "999999999999999999.99", unit: "CNY" }),
  );
  const client = createModelAccountClient(transport);
  expect((await client.status()).recovery).toBe("revocation_unknown");
  expect(await client.balance()).toEqual({ amount: "999999999999999999.99", unit: "CNY" });
});

it("automatically reconciles an unknown exchange without starting authorization", async () => {
  let recovered = false;
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("recover")) {
      recovered = true;
      return Response.json({ connected: true });
    }
    return Response.json({
      enabled: true,
      connected: recovered,
      linked: true,
      ...(!recovered ? { recovery: "authorization_unknown" } : {}),
    });
  });
  expect(await createModelAccountClient(transport).status()).toEqual({
    enabled: true,
    connected: true,
    linked: true,
  });
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    "/api/model-account/status",
    "/api/model-account/recover",
    "/api/model-account/status",
  ]);
  expect(transport.mock.calls[1]?.[1]?.method).toBe("POST");
});

it("keeps an uncertain result retryable after one failed confirmation", async () => {
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("status")
      ? Response.json({ enabled: true, connected: false, recovery: "authorization_unknown" })
      : Response.json({ error: "unavailable" }, { status: 503 }),
  );
  expect((await createModelAccountClient(transport).status()).recovery).toBe(
    "authorization_unknown",
  );
  expect(transport).toHaveBeenCalledTimes(2);
});

it("offers authorization only after the provider confirms it is required", async () => {
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("status")
      ? Response.json({ enabled: true, connected: false, recovery: "authorization_unknown" })
      : Response.json({ error: "authorization_required" }, { status: 403 }),
  );
  expect((await createModelAccountClient(transport).status()).recovery).toBe(
    "authorization_required",
  );
  expect(transport).toHaveBeenCalledTimes(2);
});
