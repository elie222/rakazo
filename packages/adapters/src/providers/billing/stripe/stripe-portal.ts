import { getLogger } from "@rakazo/logging";
import { z } from "zod";

const portalSessionSchema = z.object({ url: z.string().min(1) });

export interface StripePortalCandidate {
  id: string;
  grantsAccess: boolean;
  cancelAtPeriodEnd: boolean;
}

export interface StripePortalApi {
  request(method: "POST", path: string, params: Record<string, unknown>): Promise<unknown>;
  pickCancelCandidate(customerId: string): Promise<StripePortalCandidate | null>;
  isInvalidRequestError(error: unknown): boolean;
}

/** Opens the Stripe billing portal, targeting direct subscription cancellation when eligible. */
export async function createStripePortal(
  api: StripePortalApi,
  input: { customerId: string; returnUrl: string; flow?: "cancel" },
): Promise<{ url: string }> {
  const base = { customer: input.customerId, return_url: input.returnUrl };
  if (input.flow === "cancel") {
    const candidate = await api.pickCancelCandidate(input.customerId);
    if (candidate?.grantsAccess && !candidate.cancelAtPeriodEnd) {
      try {
        const session = portalSessionSchema.parse(
          await api.request("POST", "/v1/billing_portal/sessions", {
            ...base,
            flow_data: {
              type: "subscription_cancel",
              subscription_cancel: { subscription: candidate.id },
            },
          }),
        );
        return { url: session.url };
      } catch (error) {
        if (!api.isInvalidRequestError(error)) throw error;
        getLogger().warn("Stripe cancel portal flow rejected; falling back to general portal", {
          customerId: input.customerId,
          subscriptionId: candidate.id,
          error,
        });
      }
    }
  }
  const session = portalSessionSchema.parse(
    await api.request("POST", "/v1/billing_portal/sessions", base),
  );
  return { url: session.url };
}
