import { oc } from "@orpc/contract";
import * as z from "zod";
import { AnalyticsSurface } from "../account/analytics.js";
import { Id } from "../ids.js";
import { AccessGrantInputSchema, AccessGrantSchema } from "./access-grants.js";
import {
  BillingClientSchema,
  BillingStatusSchema,
  ByokIntervalSchema,
  ByokTierSchema,
  ModelCreditAmountSchema,
} from "./billing.js";
import {
  PaymentWalletStatusSchema,
  SpendingLimitSchema,
  SpendingPaymentSchema,
  SpendingStatusSchema,
} from "./payments.js";
import {
  PlanLimitsSchema,
  UsageBreakdownInputSchema,
  UsageBreakdownSchema,
  UsageRecordSchema,
  UsageSummarySchema,
} from "./usage.js";

export const billingRpc = {
  billing: {
    /** Claims an invite code first when one is sent, so the status already reflects it. */
    status: oc
      .input(z.object({ referralCode: z.string().min(1).max(64).optional() }).optional())
      .output(BillingStatusSchema),
    computerUsage: oc.output(
      z.object({
        computers: z.array(
          z.object({
            id: z.string(),
            scope: z.enum(["team", "dedicated"]),
            botName: z.string().nullable(),
            hours: z.number().nonnegative(),
          }),
        ),
        otherHours: z.number().nonnegative(),
      }),
    ),
    /** Re-reads the subscription from the provider, e.g. right after a mobile checkout. */
    refresh: oc.output(BillingStatusSchema),
    selectFunding: oc
      .input(
        z.object({
          funding: z.enum(["byok", "credits"]),
          client: BillingClientSchema,
          surface: AnalyticsSurface.optional(),
          /** Billing period of the own-key plan's checkout; monthly when omitted. */
          interval: ByokIntervalSchema.optional(),
          /** The own-key plan's tier; Standard when omitted. */
          tier: ByokTierSchema.optional(),
        }),
      )
      /** `url` is the checkout to pay for the own-key plan before it has access. */
      .output(z.object({ ok: z.literal(true), url: z.string().url().optional() })),
    purchaseCredits: oc
      .input(
        z.object({
          amountCents: ModelCreditAmountSchema,
          monthly: z.boolean(),
          client: BillingClientSchema,
        }),
      )
      .output(z.object({ url: z.string().url() })),
    setMonthlyCredits: oc
      .input(z.object({ amountCents: ModelCreditAmountSchema }))
      .output(z.object({ ok: z.literal(true) })),
    checkout: oc
      .input(
        z
          .object({
            client: BillingClientSchema,
            interval: ByokIntervalSchema.optional(),
            /** The own-key plan's tier; Standard when omitted. */
            tier: ByokTierSchema.optional(),
          })
          .optional(),
      )
      .output(z.object({ url: z.string().url() })),
    portal: oc
      .input(z.object({ client: BillingClientSchema }).optional())
      .output(z.object({ url: z.string().url() })),
    /** Owners only: ends the running trial and bills the first period now. */
    endTrial: oc.output(BillingStatusSchema),
    /** Owners only: moves a monthly own-key plan to yearly, charging the difference now. */
    switchToYearly: oc.output(BillingStatusSchema),
    /** Owners only: moves the own-key plan to another tier at the same interval, billing the difference now. */
    changeTier: oc.input(z.object({ tier: ByokTierSchema })).output(BillingStatusSchema),
    /** Records who invited this organization; ignored once it has subscribed. */
    claimReferral: oc
      .input(z.object({ code: z.string().min(1).max(64) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /** Admins only, on deployments that sell model credits. */
  accessGrants: {
    list: oc.output(z.array(AccessGrantSchema)),
    create: oc.input(AccessGrantInputSchema).output(AccessGrantSchema),
    revoke: oc.input(z.object({ id: Id })).output(AccessGrantSchema),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(UsageSummarySchema),
    breakdown: oc.input(UsageBreakdownInputSchema).output(UsageBreakdownSchema),
    /** Subscription sign-ins whose allowance could be read; others are left out. */
    limits: oc.output(z.array(PlanLimitsSchema)),
  },
  /** The account's spending limit for payments its bots make. */
  spendingLimit: {
    get: oc.output(SpendingStatusSchema),
    /** `null` removes the limit. */
    set: oc
      .input(z.object({ limit: SpendingLimitSchema.nullable() }).strict())
      .output(SpendingStatusSchema),
    /** The latest payments that count, newest first. */
    payments: oc.output(z.array(SpendingPaymentSchema)),
  },
  /** The signed-in user's wallet; absent when the deployment offers none. */
  paymentWallet: {
    status: oc.output(PaymentWalletStatusSchema),
    /** Starts a sign-in the user finishes with the provider; `status` then reports it. */
    connect: oc.output(PaymentWalletStatusSchema),
    disconnect: oc.output(PaymentWalletStatusSchema),
  },
};
