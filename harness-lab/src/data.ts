import { israeliIdFromBase, rng } from "./lib/core.js";

/** Every person, number and credential here is invented. Phones use the 055-5xx range. */

export interface YearReport {
  year: 2023 | 2024 | 2025;
  openingBalance: number;
  deposits: number;
  returnPct: number;
  feeFromDepositsPct: number;
  feeFromBalancePct: number;
  closingBalance: number;
}

export interface Fund {
  id: string;
  kind: "pension" | "hishtalmut" | "gemel";
  nameHe: string;
  nameEn: string;
  /** Shown on screen. Yearly returns are deliberately only in the PDFs. */
  balance: number;
  ytdReturnPct: number;
  reports: YearReport[];
}

export interface PensionUser {
  id: string;
  nameHe: string;
  nameEn: string;
  idNumber: string;
  phone: string;
  email: string;
  funds: Fund[];
}

const YEARS = [2023, 2024, 2025] as const;

function fund(
  userId: string,
  kind: Fund["kind"],
  nameHe: string,
  nameEn: string,
  start: number,
  yearlyDeposit: number,
  returns: [number, number, number],
  fees: [number, number],
  ytd: number,
): Fund {
  const r = rng(`${userId}:${kind}`);
  let opening = start;
  const reports = YEARS.map((year, i) => {
    const deposits = Math.round(yearlyDeposit * (0.97 + r() * 0.06));
    const pct = returns[i]!;
    const closing = Math.round((opening + deposits * 0.5) * (1 + pct / 100) + deposits * 0.5);
    const rep: YearReport = {
      year,
      openingBalance: opening,
      deposits,
      returnPct: pct,
      feeFromDepositsPct: fees[0],
      feeFromBalancePct: fees[1],
      closingBalance: closing,
    };
    opening = closing;
    return rep;
  });
  return {
    id: `${userId}-${kind}`,
    kind,
    nameHe,
    nameEn,
    balance: opening + 18_400,
    ytdReturnPct: ytd,
    reports,
  };
}

export const PENSION_USERS: PensionUser[] = [
  {
    id: "dana",
    nameHe: "דנה אלון",
    nameEn: "Dana Alon",
    idNumber: israeliIdFromBase("00000001"),
    phone: "0555000101",
    email: "dana.alon@example.test",
    funds: [
      fund(
        "dana",
        "pension",
        "קדם פנסיה מקיפה - מסלול כללי",
        "Kedem Comprehensive Pension - General",
        412_000,
        54_000,
        [11.84, 13.21, 8.47],
        [4.0, 0.21],
        4.9,
      ),
      fund(
        "dana",
        "hishtalmut",
        "קדם קרן השתלמות - מסלול מניות",
        "Kedem Study Fund - Equities",
        96_500,
        15_500,
        [14.62, 17.03, 9.88],
        [0, 0.65],
        6.1,
      ),
      fund(
        "dana",
        "gemel",
        "קדם גמל להשקעה - US Large-Cap Index",
        "Kedem Investment Gemel - US Large-Cap Index",
        38_000,
        6_000,
        [24.1, 23.7, 12.35],
        [0, 0.4],
        7.2,
      ),
    ],
  },
  {
    id: "yossi",
    nameHe: "יוסי דרור",
    nameEn: "Yossi Dror",
    idNumber: israeliIdFromBase("00000002"),
    phone: "0555000102",
    email: "yossi.dror@example.test",
    funds: [
      fund(
        "yossi",
        "pension",
        "קדם פנסיה מקיפה - מסלול לבני 50 ומטה",
        "Kedem Comprehensive Pension - Age 50 and under",
        655_000,
        71_000,
        [10.95, 12.4, 7.62],
        [3.5, 0.19],
        4.2,
      ),
      fund(
        "yossi",
        "hishtalmut",
        "קדם קרן השתלמות - מסלול כללי",
        "Kedem Study Fund - General",
        143_000,
        18_000,
        [9.7, 11.15, 6.9],
        [0, 0.55],
        3.8,
      ),
    ],
  },
  {
    id: "maya",
    nameHe: "מאיה ברק",
    nameEn: "Maya Barak",
    idNumber: israeliIdFromBase("00000003"),
    phone: "0555000103",
    email: "maya.barak@example.test",
    funds: [
      fund(
        "maya",
        "pension",
        "קדם פנסיה מקיפה - מסלול כללי",
        "Kedem Comprehensive Pension - General",
        228_000,
        39_000,
        [12.3, 14.05, 9.11],
        [4.0, 0.22],
        5.0,
      ),
      fund(
        "maya",
        "gemel",
        "קדם גמל - מסלול אג״ח",
        "Kedem Gemel - Bonds",
        21_000,
        4_800,
        [6.1, 5.4, 4.05],
        [0, 0.35],
        2.1,
      ),
    ],
  },
];

export const KIND_LABEL = {
  pension: { he: "פנסיה", en: "Pension" },
  hishtalmut: { he: "קרן השתלמות", en: "Study fund" },
  gemel: { he: "קופת גמל", en: "Provident fund" },
} as const;

// ----- investment house ("Tavor") -----

export interface Holding {
  symbol: string;
  nameHe: string;
  qty: number;
  price: number;
  costBasis: number;
}

export interface QuarterReport {
  quarter: string;
  returnPct: number;
  endValue: number;
  deposits: number;
  fees: number;
}

export interface InvestUser {
  id: string;
  username: string;
  password: string;
  idNumber: string;
  nameHe: string;
  nameEn: string;
  phone: string;
  email: string;
  holdings: Holding[];
  cash: number;
  quarters: QuarterReport[];
}

const HOLDINGS: Holding[] = [
  { symbol: "TVR-TA35", nameHe: "תבור מחקה ת״א 35", qty: 420, price: 287.4, costBasis: 241.1 },
  {
    symbol: "TVR-USLC",
    nameHe: "תבור מחקה US Large-Cap Index",
    qty: 150,
    price: 512.8,
    costBasis: 430.0,
  },
  { symbol: "GOV-5Y", nameHe: "אג״ח ממשלתי צמוד 5 שנים", qty: 9_000, price: 1.12, costBasis: 1.05 },
  { symbol: "LMD", nameHe: "לימד טכנולוגיות בע״מ", qty: 75, price: 143.6, costBasis: 118.9 },
  { symbol: "ORN", nameHe: "אורן תעשיות", qty: 310, price: 41.25, costBasis: 47.5 },
  { symbol: "KRM", nameHe: "כרמל נדל״ן", qty: 220, price: 66.7, costBasis: 58.2 },
];

export const INVEST_USERS: InvestUser[] = [
  {
    id: "ronen",
    username: "ronen.k",
    password: "Lab-Pass-2025!",
    idNumber: israeliIdFromBase("00000011"),
    nameHe: "רונן כץ",
    nameEn: "Ronen Katz",
    phone: "0555000201",
    email: "ronen.katz@example.test",
    holdings: HOLDINGS,
    cash: 18_250.4,
    quarters: [
      { quarter: "2025-Q1", returnPct: 2.31, endValue: 402_118.5, deposits: 0, fees: 612.3 },
      { quarter: "2025-Q2", returnPct: -1.42, endValue: 398_910.2, deposits: 5_000, fees: 598.1 },
      { quarter: "2025-Q3", returnPct: 4.87, endValue: 424_702.9, deposits: 0, fees: 640.75 },
    ],
  },
  {
    id: "tamar",
    username: "tamar.l",
    password: "Lab-Pass-2025!",
    idNumber: israeliIdFromBase("00000012"),
    nameHe: "תמר לוי",
    nameEn: "Tamar Levi",
    phone: "0555000202",
    email: "tamar.levi@example.test",
    holdings: HOLDINGS.slice(0, 3).map((h) => ({ ...h, qty: Math.round(h.qty / 3) })),
    cash: 4_120,
    quarters: [
      { quarter: "2025-Q1", returnPct: 1.95, endValue: 118_400.0, deposits: 2_000, fees: 180.4 },
      { quarter: "2025-Q2", returnPct: -0.8, endValue: 119_730.0, deposits: 2_000, fees: 176.0 },
      { quarter: "2025-Q3", returnPct: 3.6, endValue: 126_040.0, deposits: 2_000, fees: 190.2 },
    ],
  },
];

export const STATEMENT_MONTHS = ["2025-07", "2025-08", "2025-09"] as const;

/** Month-end statement rows: deterministic transactions per user and month. */
export function statementRows(user: InvestUser, month: string) {
  const r = rng(`${user.id}:${month}`);
  const rows: { date: string; description: string; amount: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const day = String(2 + Math.floor(r() * 26)).padStart(2, "0");
    const h = user.holdings[Math.floor(r() * user.holdings.length)]!;
    const buy = r() > 0.45;
    const qty = 1 + Math.floor(r() * 20);
    rows.push({
      date: `${month}-${day}`,
      description: `${buy ? "Buy" : "Sell"} ${qty} x ${h.symbol}`,
      amount: Math.round((buy ? -1 : 1) * qty * h.price * 100) / 100,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// ----- flights ("Skybird") -----

export const AIRPORTS = [
  { code: "TLV", city: "Tel Aviv", cityHe: "תל אביב", name: "Ben Gurion" },
  { code: "ATH", city: "Athens", cityHe: "אתונה", name: "Eleftherios Venizelos" },
  { code: "LCA", city: "Larnaca", cityHe: "לרנקה", name: "Larnaca" },
  { code: "LHR", city: "London", cityHe: "לונדון", name: "Heathrow" },
  { code: "CDG", city: "Paris", cityHe: "פריז", name: "Charles de Gaulle" },
  { code: "FCO", city: "Rome", cityHe: "רומא", name: "Fiumicino" },
  { code: "BCN", city: "Barcelona", cityHe: "ברצלונה", name: "El Prat" },
  { code: "BER", city: "Berlin", cityHe: "ברלין", name: "Brandenburg" },
  { code: "AMS", city: "Amsterdam", cityHe: "אמסטרדם", name: "Schiphol" },
  { code: "JFK", city: "New York", cityHe: "ניו יורק", name: "John F. Kennedy" },
] as const;

export const AIRLINES = [
  { code: "SB", name: "Skybird" },
  { code: "NV", name: "Nimbus Air" },
  { code: "AZ", name: "Azure Wings" },
  { code: "OL", name: "Olive Jet" },
] as const;
