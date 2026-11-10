import type { SourceLink } from "../alternatives";
import { GITHUB_URL, SITE_URL } from "../site";
import type { SandboxImage } from "./types";

export const SANDBOXES_PATH = "/sandboxes/";
export const SANDBOXES_UPDATED = "November 4, 2026";
export const COMPUTER_PROVIDERS_DOCS_PATH = "/docs/self-host-sandbox-providers/";
export const COMPUTER_DOCS_PATH = "/docs/computer/";
export const SELF_HOST_PATH = "/self-hosted-ai-agent/";

export function sandboxPath(slug: string): string {
  return `${SANDBOXES_PATH}${slug}/`;
}

/** A provider homepage screenshot in `public/graphics/sandboxes/`. */
export function homepage(slug: string, provider: string, alt: string): SandboxImage {
  return {
    webp: `/graphics/sandboxes/${slug}.webp`,
    avif: `/graphics/sandboxes/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const PROVIDERS_DOC: SourceLink = {
  label: "Rakazo, computer providers",
  href: `${GITHUB_URL}/blob/main/docs/self-host-sandbox-providers.md`,
};

export const RUNTIME_DOC: SourceLink = {
  label: "Rakazo, computer runtime and isolation",
  href: `${GITHUB_URL}/blob/main/docs/computer-runtime.md`,
};

/** Small print under every price table. */
export const PRICES_NOTE =
  "Prices in US dollars unless marked, from each provider's pricing page, checked November 2026. Your model provider bills separately.";

/*
 * Every worked example prices the same workload, so a rate typed once here reaches the hub, the
 * provider pages and the shared comparison table.
 */

/** Hours a month a computer runs 4 hours a workday, and around the clock. */
export const WORKDAY_HOURS = 88;
export const MONTH_HOURS = 720;

export type ComputerShape = { vcpus: number; gb: number };
/** The size every example prices: enough for a Linux desktop, Chromium and a terminal. */
export const EXAMPLE_SIZE: ComputerShape = { vcpus: 2, gb: 4 };

/** One sentence on provider pages pointing at the hub, where the method is explained once. */
export const METHOD_NOTE =
  "Monthly costs follow [the method on the comparison page](/sandboxes/#pricing): one person's bots sharing one 2 vCPU / 4 GB computer, running 4 hours a workday or around the clock. For N people, multiply by N.";

/** Per-hour CPU and memory rates. */
export type Rate = { vcpuHour: number; gbHour: number };

function perSecond(vcpuSecond: number, gbSecond: number): Rate {
  return { vcpuHour: vcpuSecond * 3600, gbHour: gbSecond * 3600 };
}

/** Providers that bill CPU and memory separately, as of November 2026. */
export const RATES = {
  e2b: perSecond(0.000014, 0.0000045),
  daytona: { vcpuHour: 0.0504, gbHour: 0.0162 },
  novita: perSecond(0.0000098, 0.0000032),
  // InstaBox publishes hourly rates and meters by the second.
  instabox: { vcpuHour: 0.004, gbHour: 0.00225 },
  // Modal bills per physical core, which is 2 vCPU, at 3x list price for sandboxes.
  modal: perSecond(0.00003942 / 2, 0.00000667),
  northflank: { vcpuHour: 0.01667, gbHour: 0.00833 },
  createos: { vcpuHour: 0.03616363, gbHour: 0.01159025 },
  // Blaxel bills memory only.
  blaxel: perSecond(0, 0.0000115),
  // Railway sandboxes bill CPU actually used and memory actually held.
  railway: perSecond(0.00001929, 0.00001929),
} satisfies Record<string, Rate>;

export function hourly(rate: Rate, size: ComputerShape = EXAMPLE_SIZE): number {
  return rate.vcpuHour * size.vcpus + rate.gbHour * size.gb;
}

export function monthly(rate: Rate, hours: number, size: ComputerShape = EXAMPLE_SIZE): number {
  return hourly(rate, size) * hours;
}

/** An hourly rate as the per-second price providers publish, such as "$0.000014". */
export function perSecondUsd(hourRate: number): string {
  return `$${Number((hourRate / 3600).toPrecision(3))}`;
}

/** A small hourly rate to two significant figures, such as "$0.016". */
export function rateUsd(hourRate: number): string {
  return `$${Number(hourRate.toPrecision(2))}`;
}

/** Dollars and cents, or whole dollars for a round amount such as a monthly minimum. */
export function usd(amount: number): string {
  const cents = amount.toFixed(2);
  return `$${cents.endsWith(".00") ? cents.slice(0, -3) : cents}`;
}

/** A rounded estimate, such as "about $34". */
export function aboutUsd(amount: number): string {
  return `about $${Math.round(amount)}`;
}

export function euro(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export const E2B_PRO_FEE = 150;
export const E2B_CREDIT = 100;
export const DAYTONA_CREDIT = 200;
export const NOVITA_CREDIT = 100;

/** E2B's stock desktop, which Rakazo falls back to before its own template is built. */
export const E2B_STOCK_SIZE: ComputerShape = { vcpus: 8, gb: 8 };

/** Boat prices per machine size, with a monthly minimum that counts as machine time. */
export const BOAT = {
  minimum: 20,
  small: { vcpus: 2, gb: 4, hour: 0.018 },
  default: { vcpus: 4, gb: 8, hour: 0.036 },
  large: { vcpus: 8, gb: 16, hour: 0.072 },
  xlarge: { vcpus: 16, gb: 32, hour: 0.2 },
} as const;

/**
 * The Boat machine Rakazo starts for each computer size. A computer gets the size of its
 * organization's Rakazo Cloud plan; everything else, including every self-hosted install, uses
 * the standard size, which is Boat's default machine.
 */
export const BOAT_SIZES = [
  {
    plan: "Rakazo Cloud's Standard plan and Rakazo credits, and every self-hosted install",
    machine: "default",
    ...BOAT.default,
  },
  { plan: "The Rakazo Cloud Pro plan", machine: "large", ...BOAT.large },
  { plan: "The Rakazo Cloud Max plan", machine: "xlarge", ...BOAT.xlarge },
] as const;

/** The standard size, which the worked examples price. */
export const BOAT_RAKAZO = BOAT.default;

export function boatMonthly(hourPrice: number, hours: number): number {
  return Math.max(BOAT.minimum, hourPrice * hours);
}

/**
 * Rakazo runs every InstaBox computer at the plan's default size. The Pro fee comes back each
 * month as usage credit, so it works like a monthly minimum.
 */
export const INSTABOX = {
  size: { vcpus: 4, gb: 8 },
  proFee: 20,
} as const;

export function instaboxProMonthly(hours: number, size: ComputerShape = INSTABOX.size): number {
  return Math.max(INSTABOX.proFee, monthly(RATES.instabox, hours, size));
}

/** The shape Rakazo gives every InstaBox computer, such as "4 vCPU / 8 GB". */
export function instaboxShape(size: ComputerShape = INSTABOX.size): string {
  return `${size.vcpus} vCPU / ${size.gb} GB`;
}

export function instaboxHour(size: ComputerShape = INSTABOX.size): number {
  return hourly(RATES.instabox, size);
}

/** Hours of that computer the Pro fee's usage credit covers, rounded to the nearest 10. */
export function instaboxCreditHours(size: ComputerShape = INSTABOX.size): number {
  return Math.round(INSTABOX.proFee / instaboxHour(size) / 10) * 10;
}

/** Vercel bills CPU only while busy, and provisioned memory the whole time. */
export const VERCEL = { activeCpuHour: 0.128, gbHour: 0.0212 };

export function vercelMonthly(hours: number, busyShare: number, size: ComputerShape = EXAMPLE_SIZE): number {
  return hours * (size.vcpus * busyShare * VERCEL.activeCpuHour + size.gb * VERCEL.gbHour);
}

/** Railway's estimate: what a desktop uses on average, and the Rakazo app and database beside it. */
export const RAILWAY_ESTIMATE = {
  computer: { vcpus: 0.5, gb: 2.5 },
  app: { vcpus: 0.1, gb: 1 },
  /** Container rates per month, for the app and database. */
  vcpuMonth: 20,
  gbMonth: 10,
  databaseAndVolumes: 4,
} as const;

export const railwayComputerMonthly = (hours: number) => monthly(RATES.railway, hours, RAILWAY_ESTIMATE.computer);
export const railwayAppMonthly =
  RAILWAY_ESTIMATE.app.vcpus * RAILWAY_ESTIMATE.vcpuMonth +
  RAILWAY_ESTIMATE.app.gb * RAILWAY_ESTIMATE.gbMonth +
  RAILWAY_ESTIMATE.databaseAndVolumes;

/**
 * Alibaba Cloud's example prices for a 4 vCPU / 8 GiB Wuying computer, the smallest size its
 * billing docs give, with an 80 GiB system disk.
 */
export const WUYING = {
  size: { vcpus: 4, gb: 8 },
  hour: 0.148,
  plan120: 15.8,
  unlimited: 53.3,
  diskGb: 80,
  diskGbHour: 0.00007,
  diskGbMonth: 0.051,
  cny: { hour: 0.727, plan120: 59, unlimited: 199, diskGbHour: 0.00035, diskGbMonth: 0.25 },
} as const;

export const wuyingPayAsYouGo = (hours: number) =>
  WUYING.hour * hours + WUYING.diskGb * WUYING.diskGbHour * MONTH_HOURS;
export const wuyingPlan120 = (hours: number) =>
  Math.min(WUYING.unlimited, WUYING.plan120 + Math.max(0, hours - 120) * WUYING.hour) +
  WUYING.diskGb * WUYING.diskGbMonth;
export const wuyingUnlimited = WUYING.unlimited + WUYING.diskGb * WUYING.diskGbMonth;

/** Servers for self-hosted computers, per month. */
export const SERVERS = {
  hetznerCx33: 8.99,
  hetznerCx43: 16.49,
  hetznerAx42: 79,
  digitalOcean16: 96,
  awsM7i2xlarge: 294,
  /** GKE and EKS charge $0.10 an hour per cluster. */
  controlPlane: 0.1 * 730,
} as const;

/** Docker computers are capped at 2 GB by default; Rakazo and its database take about 4 GB. */
export const DOCKER_MEMORY = { computerGb: 2, rakazoGb: 4 };
export const dockerComputersFit = (serverGb: number) =>
  Math.floor((serverGb - DOCKER_MEMORY.rakazoGb) / DOCKER_MEMORY.computerGb);

/**
 * Kubernetes reserves a pod's full limit when only limits are set, and the node's own pods take
 * about a vCPU, so an 8 vCPU node fits this many 2 vCPU / 4Gi computers.
 */
export const KUBERNETES_NODE_FITS = Math.floor((8 - 1) / EXAMPLE_SIZE.vcpus);

/** An always-on Mac mini's electricity, at an assumed average draw and price. */
export const MAC_MINI = { watts: 20, kwh: 0.2 };
export const macMiniMonthly = (hours: number) => (MAC_MINI.watts * hours * MAC_MINI.kwh) / 1000;

/** Pricing pages cited by more than one sandbox page. */
export const PRICING = {
  boat: { label: "Boat pricing", href: "https://boat.dev" },
  e2b: { label: "E2B pricing", href: "https://e2b.dev/pricing" },
  daytona: { label: "Daytona pricing", href: "https://www.daytona.io/pricing" },
  novita: { label: "Novita sandbox pricing", href: "https://docs.novita.ai/guides/sandbox-pricing" },
  instabox: { label: "InstaBox pricing", href: "https://instabox.sh/pricing" },
  railway: { label: "Railway sandboxes, pricing and limits", href: "https://docs.railway.com/sandboxes" },
  wuying: {
    label: "Alibaba Cloud, Elastic Desktop Service billing",
    href: "https://www.alibabacloud.com/help/en/wuying-workspace/product-overview/billing-overview",
  },
  modal: { label: "Modal pricing", href: "https://modal.com/pricing" },
  vercel: { label: "Vercel Sandbox pricing", href: "https://vercel.com/docs/vercel-sandbox/pricing" },
  northflank: { label: "Northflank pricing", href: "https://northflank.com/pricing" },
  blaxel: { label: "Blaxel pricing", href: "https://blaxel.ai/pricing" },
  createos: { label: "CreateOS sandbox pricing", href: "https://createos.sh/pricing/sandbox" },
  dockerSandboxes: {
    label: "Docker, Cloud Sandboxes",
    href: "https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/",
  },
  hetzner: { label: "Hetzner Cloud pricing", href: "https://www.hetzner.com/cloud/cost-optimized/" },
  digitalocean: { label: "DigitalOcean Droplet pricing", href: "https://www.digitalocean.com/pricing/droplets" },
  rakazo: { label: "Rakazo pricing", href: `${SITE_URL}/pricing/` },
} satisfies Record<string, SourceLink>;
