/** The billing provider no longer has this customer, e.g. it was deleted in the vendor's dashboard. */
export class BillingCustomerNotFoundError extends Error {
  readonly code = "BILLING_CUSTOMER_NOT_FOUND";
  constructor(options?: { cause?: unknown }) {
    super("Billing customer no longer exists", options);
    this.name = "BillingCustomerNotFoundError";
  }
}

/** An earlier checkout completed while a new one was being opened; another would bill twice. */
export class BillingCheckoutCompletedError extends Error {
  readonly code = "BILLING_CHECKOUT_COMPLETED";
  constructor() {
    super("An earlier checkout has already completed");
    this.name = "BillingCheckoutCompletedError";
  }
}
