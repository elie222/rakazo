import type { PartnerProgram } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import { z } from "zod";

const API = "https://api.dub.co";
const TIMEOUT_MS = 10_000;

/** The affiliate program on Dub; enabled by `DUB_API_KEY`. */
export function createDubPartnerProgram(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): PartnerProgram {
  async function request(method: string, path: string, body?: object): Promise<unknown> {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: deadlineSignal(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Partner program request ${method} ${path} failed: ${response.status}`);
    return response.json();
  }

  return {
    async trackSignup({ clickId, customerId, name, email }) {
      await request("POST", "/track/lead", {
        clickId,
        eventName: "Sign Up",
        customerExternalId: customerId,
        ...(name ? { customerName: name.slice(0, 100) } : {}),
        ...(email.length <= 100 ? { customerEmail: email } : {}),
      });
    },
    async trackSale({ customerId, invoiceId, amountCents, currency }) {
      await request("POST", "/track/sale", {
        customerExternalId: customerId,
        amount: amountCents,
        currency,
        eventName: "Invoice paid",
        paymentProcessor: "stripe",
        invoiceId,
      });
    },
    async refundSale(invoiceId) {
      const commissions = z
        .array(z.object({ id: z.string(), status: z.string() }))
        .parse(await request("GET", `/commissions?invoiceId=${encodeURIComponent(invoiceId)}`));
      for (const commission of commissions) {
        if (commission.status === "refunded") continue;
        await request("PATCH", `/commissions/${encodeURIComponent(commission.id)}`, {
          status: "refunded",
        });
      }
    },
  };
}
