/**
 * Optional affiliate program that pays partners for the customers they refer. Product code decides
 * which payments count; the program only records them. Calls may fail and callers treat them as
 * best effort.
 */
export interface PartnerProgram {
  /** Records that the click `clickId` brought customer `customerId`; the program ignores repeats. */
  trackSignup(input: {
    clickId: string;
    customerId: string;
    name: string;
    email: string;
  }): Promise<void>;
  /** Records a payment the partner earns on; the program records each `invoiceId` once. */
  trackSale(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    currency: string;
  }): Promise<void>;
  /**
   * Withdraws the partner's earnings on a payment that was refunded or lost to a dispute. Says
   * `not_found` when the program has no earnings for it yet, and `already_paid` when they were paid
   * out before the refund and must be recovered by hand.
   */
  refundSale(invoiceId: string): Promise<"withdrawn" | "not_found" | "already_paid">;
}
