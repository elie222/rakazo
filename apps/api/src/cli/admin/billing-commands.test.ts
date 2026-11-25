import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminContext } from "./admin-command.js";
import { billingCancelCommand, billingRefundCommand } from "./billing-commands.js";

const mocks = vi.hoisted(() => ({
  refundInvoice: vi.fn(),
  cancelOrganizationSubscriptions: vi.fn(),
  sync: vi.fn(),
  reportPartnerSales: vi.fn(),
  recordAuditEvent: vi.fn(),
}));
vi.mock("./billing-provider.js", () => ({
  adminBillingProvider: () => ({
    refundInvoice: mocks.refundInvoice,
    getCustomerSubscription: async () => ({ status: "active", cancelAtPeriodEnd: false }),
  }),
}));
vi.mock("../../billing/billing.js", () => ({
  createBillingService: () => ({
    cancelOrganizationSubscriptions: mocks.cancelOrganizationSubscriptions,
    sync: mocks.sync,
    reportPartnerSales: mocks.reportPartnerSales,
  }),
}));
vi.mock("../../billing/checkout-lease.js", () => ({
  withCheckoutLease: (_prisma: unknown, _id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ownedBillingAccounts: async () => [{ organizationId: "org_fixture", customerId: "cus_fixture" }],
  recordAuditEvent: mocks.recordAuditEvent,
  unexpiredCreditAccount: async () => ({ balanceMicros: 9_680_000n }),
}));

const email = "person@example.test";
const preview = {
  invoiceId: "in_fixture",
  invoiceNumber: "EXAMPLE-0001",
  creditPurchaseId: "in_fixture",
  createdAt: "2030-01-01T00:00:00.000Z",
  amountMinor: 1000,
  currency: "usd",
  state: "refundable",
};
const context = {
  env: {},
  prisma: {
    user: { findMany: async () => [{ id: "user_fixture", email }] },
    modelCreditAccount: { findUnique: async () => ({ balanceMicros: 9_680_000n }) },
    modelCreditLot: { findUnique: async () => ({ usedMicros: 320_000n }) },
    modelCreditEntry: {
      findUnique: async () => ({
        id: "entry_fixture",
        organizationId: "org_fixture",
        amountMicros: 10_000_000n,
        createdAt: new Date("2030-01-01T00:00:05Z"),
      }),
      groupBy: async () => [{ model: "example/model", _sum: { amountMicros: -320_000n } }],
    },
  },
} as unknown as AdminContext;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("operator billing writes", () => {
  it("audits a cancellation request before any later sync failure", async () => {
    mocks.cancelOrganizationSubscriptions.mockImplementation(async () => {
      expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "billing.subscriptions.cancel_requested",
          organizationId: "org_fixture",
        }),
      );
      throw new Error("Billing sync failed");
    });
    const cancel = billingCancelCommand.parse([email], { confirm: true })!;
    await expect(cancel(context)).rejects.toThrow("Billing sync failed");
    expect(mocks.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("previews a refund that keeps what paid for the credits used", async () => {
    mocks.refundInvoice.mockResolvedValueOnce(preview);
    const refund = billingRefundCommand.parse([email], {})!;
    const result = await refund(context);
    expect(mocks.refundInvoice).toHaveBeenCalledWith("cus_fixture", undefined, false);
    expect(result.json).toMatchObject({
      refundMinor: 968,
      keptMinor: 32,
      balanceAfterRefund: 0,
      subscriptionRenews: true,
    });
    expect(result.text).toContain("Add EXAMPLE-0001 --confirm");
  });

  it("reports a refund already sent instead of planning another", async () => {
    const sent = { ...preview, state: "succeeded", refundId: "re_fixture", refundedMinor: 968 };
    mocks.refundInvoice.mockResolvedValueOnce(sent).mockResolvedValueOnce(sent);
    const refund = billingRefundCommand.parse([email, "EXAMPLE-0001"], { confirm: true })!;
    await expect(refund(context)).resolves.toMatchObject({ json: { refundedMinor: 968 } });
    expect(mocks.refundInvoice).toHaveBeenLastCalledWith(
      "cus_fixture",
      "EXAMPLE-0001",
      true,
      undefined,
    );
  });

  it("refunds the whole charge with --full", async () => {
    mocks.refundInvoice.mockResolvedValueOnce(preview).mockResolvedValueOnce({
      ...preview,
      state: "pending",
      refundId: "re_fixture",
      refundedMinor: 968,
    });
    const refund = billingRefundCommand.parse([email, "EXAMPLE-0001"], {
      confirm: true,
      full: true,
    })!;
    await refund(context);
    expect(mocks.refundInvoice).toHaveBeenLastCalledWith("cus_fixture", "EXAMPLE-0001", true, 1000);
  });

  it("audits a refund request before sending it and reconciles after an uncertain response", async () => {
    mocks.refundInvoice.mockResolvedValueOnce(preview).mockImplementationOnce(async () => {
      expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "billing.invoice.refund_requested",
          target: { type: "invoice", id: preview.invoiceId },
        }),
      );
      throw new Error("Unknown refund outcome");
    });
    mocks.sync.mockRejectedValue(new Error("Billing sync failed"));
    const refund = billingRefundCommand.parse([email, "EXAMPLE-0001"], { confirm: true })!;
    await expect(refund(context)).rejects.toThrow("Unknown refund outcome");
    expect(mocks.sync).toHaveBeenCalledWith("cus_fixture");
    expect(mocks.reportPartnerSales).toHaveBeenCalledWith("cus_fixture");
  });

  it("records the provider's reported refund outcome separately from the request", async () => {
    mocks.refundInvoice.mockResolvedValueOnce(preview).mockResolvedValueOnce({
      ...preview,
      state: "pending",
      refundId: "re_fixture",
      refundedMinor: 968,
    });
    const refund = billingRefundCommand.parse([email, "EXAMPLE-0001"], { confirm: true })!;
    await expect(refund(context)).resolves.toMatchObject({ json: { state: "pending" } });
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.invoice.refund_result",
        target: { type: "invoice", id: preview.invoiceId },
        metadata: { refundId: "re_fixture", status: "pending", amountMinor: 968, currency: "usd" },
      }),
    );
  });
});
