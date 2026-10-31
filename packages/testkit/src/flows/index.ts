import { bookCheapestFlight } from "./book-cheapest-flight.js";
import { connectMcp } from "./connect-mcp.js";
import type { Flow } from "./flow.js";
import { investQuarterly } from "./invest-quarterly.js";
import { PENSION_VARIANTS, type PensionVariant, pensionReturns } from "./pension-returns.js";
import { weeklyShopping } from "./weekly-shopping.js";

export const FLOWS: Flow<any>[] = [
  weeklyShopping,
  connectMcp,
  // Harness-lab flows: mock sites in the harness-lab container. The pension flow has one id per
  // variant (pension-returns:inline, :no-otp, :html) for A/B diagnosis.
  ...(Object.keys(PENSION_VARIANTS) as PensionVariant[]).map(pensionReturns),
  investQuarterly,
  bookCheapestFlight,
];
