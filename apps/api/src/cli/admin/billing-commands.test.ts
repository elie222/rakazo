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
  adminBillingProvider: () => ({ refundInvoice: mocks.refundInvoice }),
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
}));

const email = "person@example.test";
const preview = {
  invoiceId: "in_fixture",
  amountMinor: 1000,
  currency: "usd",
  state: "refundable",
};
const context = {
  env: {},
  prisma: { user: { findMany: async () => [{ id: "user_fixture", email }] } },
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
    mocks.refundInvoice
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, state: "pending", refundId: "re_fixture" });
    const refund = billingRefundCommand.parse([email, "EXAMPLE-0001"], { confirm: true })!;
    await expect(refund(context)).resolves.toMatchObject({ json: { state: "pending" } });
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.invoice.refund_result",
        target: { type: "invoice", id: preview.invoiceId },
        metadata: { refundId: "re_fixture", status: "pending", amountMinor: 1000, currency: "usd" },
      }),
    );
  });
});
