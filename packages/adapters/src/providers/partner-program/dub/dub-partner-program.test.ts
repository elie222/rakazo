import { describe, expect, it, vi } from "vitest";
import { createDubPartnerProgram } from "./dub-partner-program.js";

function program(responses: Record<string, unknown> = {}) {
  const requests: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    requests.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const response = responses[`${init?.method} ${path}`];
    return response instanceof Response
      ? response
      : Response.json(response ?? (path.startsWith("/commissions?") ? [] : {}));
  });
  return { program: createDubPartnerProgram("dub_fixture", fetchImpl as typeof fetch), requests };
}

describe("Dub partner program", () => {
  it("records a signup as a lead under our own customer id", async () => {
    const { program: dub, requests } = program();
    await dub.trackSignup({
      clickId: "click_1",
      customerId: "user_1",
      name: "Ada",
      email: "ada@example.com",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/track/lead",
        auth: "Bearer dub_fixture",
        body: {
          clickId: "click_1",
          eventName: "Sign Up",
          customerExternalId: "user_1",
          customerName: "Ada",
          customerEmail: "ada@example.com",
        },
      },
    ]);
  });

  it("records a sale keyed on its invoice", async () => {
    const { program: dub, requests } = program();
    await dub.trackSale({
      customerId: "user_1",
      invoiceId: "in_1",
      amountCents: 1500,
      currency: "usd",
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/track/sale",
      body: {
        customerExternalId: "user_1",
        amount: 1500,
        currency: "usd",
        paymentProcessor: "stripe",
        invoiceId: "in_1",
      },
    });
  });

  it("withdraws the invoice's unpaid commissions", async () => {
    const { program: dub, requests } = program({
      "GET /commissions?invoiceId=in_1": [
        { id: "cm_pending", status: "pending" },
        { id: "cm_processed", status: "processed" },
        { id: "cm_done", status: "refunded" },
        { id: "cm_canceled", status: "canceled" },
      ],
    });
    expect(await dub.refundSale("in_1")).toBe("withdrawn");
    expect(requests.slice(1).map(({ method, path, body }) => [method, path, body])).toEqual([
      ["PATCH", "/commissions/cm_pending", { status: "refunded" }],
      ["PATCH", "/commissions/cm_processed", { status: "refunded" }],
    ]);
  });

  it("says when there is nothing yet to withdraw, or it was already paid out", async () => {
    expect(await program().program.refundSale("in_none")).toBe("not_found");
    const { program: dub, requests } = program({
      "GET /commissions?invoiceId=in_paid": [{ id: "cm_paid", status: "paid" }],
    });
    expect(await dub.refundSale("in_paid")).toBe("already_paid");
    expect(requests).toHaveLength(1);
  });

  it("accepts a write that succeeds with an empty body", async () => {
    const { program: dub } = program({
      "POST /track/sale": new Response(null, { status: 204 }),
    });
    await expect(
      dub.trackSale({ customerId: "user_1", invoiceId: "in_1", amountCents: 1, currency: "usd" }),
    ).resolves.toBeUndefined();
  });

  it("fails when the program refuses, so the caller can try again later", async () => {
    const { program: dub } = program({
      "POST /track/sale": new Response("{}", { status: 500 }),
    });
    await expect(
      dub.trackSale({ customerId: "user_1", invoiceId: "in_1", amountCents: 1, currency: "usd" }),
    ).rejects.toThrow("500");
  });
});
