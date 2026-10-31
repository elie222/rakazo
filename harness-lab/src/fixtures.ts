import { INVEST_USERS, PENSION_USERS } from "./data.js";
import { cheapestFlight } from "./sites/flights-data.js";

/** Published fixtures: credentials plus the answers a correct agent must produce. */
export function buildFixtures() {
  return {
    pension: {
      site: "Kedem Pensions (fictional)",
      otp: {
        digits: 6,
        ttlMinutes: 5,
        resendCooldownSeconds: 30,
        maxWrongTries: 3,
        lockoutMinutes: 15,
      },
      sessionInactivityMinutes: 10,
      users: PENSION_USERS.map((u) => ({
        id: u.id,
        name: u.nameEn,
        idNumber: u.idNumber,
        phone: u.phone,
        email: u.email,
        funds: u.funds.map((f) => ({
          fundId: f.id,
          kind: f.kind,
          name: f.nameEn,
          balanceOnScreen: f.balance,
          // Only present in the annual-report PDFs, not on any HTML page.
          returnsPct: Object.fromEntries(f.reports.map((r) => [r.year, r.returnPct])),
          feeFromDepositsPct: Object.fromEntries(
            f.reports.map((r) => [r.year, r.feeFromDepositsPct]),
          ),
          feeFromBalancePct: Object.fromEntries(
            f.reports.map((r) => [r.year, r.feeFromBalancePct]),
          ),
          closingBalance: Object.fromEntries(f.reports.map((r) => [r.year, r.closingBalance])),
        })),
      })),
    },
    invest: {
      site: "Tavor Investment House (fictional)",
      otp: { digits: 6, ttlMinutes: 5, channels: ["sms", "email"] },
      sessionInactivityMinutes: 10,
      users: INVEST_USERS.map((u) => ({
        id: u.id,
        name: u.nameEn,
        username: u.username,
        password: u.password,
        phone: u.phone,
        email: u.email,
        quarterlyReturnsPct: Object.fromEntries(u.quarters.map((q) => [q.quarter, q.returnPct])),
        quarterEndValue: Object.fromEntries(u.quarters.map((q) => [q.quarter, q.endValue])),
        statementMonths: ["2025-07", "2025-08", "2025-09"],
      })),
    },
    flights: {
      site: "Skybird Flights (fictional)",
      url: "http://127.0.0.1:7003/",
      note: "Prices are deterministic per route and date; no login.",
      cheapestOneWay: cheapestFlight("TLV", "ATH", "2026-12-14", 1),
      cheapestOneWayDirect: cheapestFlight("TLV", "ATH", "2026-12-14", 1, true),
    },
  };
}
