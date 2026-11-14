import type { ArticleTable } from "../provider-article/types";
import {
  BOAT,
  BOAT_RAKAZO,
  E2B_PRO_FEE,
  EXAMPLE_SIZE,
  INSTABOX,
  PRICES_NOTE,
  RATES,
  WORKDAY_HOURS,
  aboutUsd,
  boatMonthly,
  instaboxProMonthly,
  monthly,
  railwayComputerMonthly,
  usd,
  vercelMonthly,
} from "./shared";

const workday = (rate: (typeof RATES)[keyof typeof RATES]) => usd(monthly(rate, WORKDAY_HOURS));
const CREATEOS_DEFAULT_SHAPE = { vcpus: 2, gb: 2 };

/**
 * Hosted sandboxes side by side, including ones Rakazo doesn't support, for the hub and the
 * pages people reach by searching for alternatives.
 */
export const HOSTED_SANDBOXES_TABLE: ArticleTable = {
  caption: "Hosted sandboxes for AI agents compared",
  columns: [
    "Sandbox",
    "In Rakazo",
    "Isolation",
    `${WORKDAY_HOURS} hours at 2 vCPU / 4 GB`,
    "Longest session",
    "Kept when stopped",
    "Self-host or your cloud",
  ],
  rows: [
    {
      topic: "[Boat](/sandboxes/boat/)",
      cells: [
        "Yes. Rakazo Cloud runs on it",
        "Full VM per machine",
        `${usd(boatMonthly(BOAT.small.hour, WORKDAY_HOURS))}, the monthly minimum. Rakazo's smallest Boat size is ${BOAT_RAKAZO.vcpus} vCPU / ${BOAT_RAKAZO.gb} GB, which is also ${usd(boatMonthly(BOAT_RAKAZO.hour, WORKDAY_HOURS))}`,
        "No fixed cap. Rakazo renews a 2-hour lease while in use",
        "Disk",
        "No",
      ],
    },
    {
      topic: "[E2B](/sandboxes/e2b/)",
      cells: [
        "Yes",
        "Firecracker microVM",
        `${workday(RATES.e2b)}, or ${usd(monthly(RATES.e2b, WORKDAY_HOURS) + E2B_PRO_FEE)} with the Pro plan`,
        "1 hour on Hobby, 24 hours on Pro",
        "Memory and disk, when paused",
        "Open source (Apache-2.0). Your cloud on Enterprise",
      ],
    },
    {
      topic: "[Daytona](/sandboxes/daytona/)",
      cells: [
        "Yes",
        "Containers, which is how Rakazo creates them. VMs available outside Rakazo",
        workday(RATES.daytona),
        "No cap",
        "Disk. Memory only on VM sandboxes",
        "Closed source since June 2026. Your cloud on Enterprise",
      ],
    },
    {
      topic: "[Novita](/sandboxes/novita/)",
      cells: [
        "Yes",
        "Not stated",
        workday(RATES.novita),
        "1 hour free, 24 hours paid",
        "Memory and disk, when paused",
        "No",
      ],
    },
    {
      topic: "[InstaBox](/sandboxes/instabox/)",
      cells: [
        "Yes",
        "Firecracker microVM",
        `${usd(instaboxProMonthly(WORKDAY_HOURS, EXAMPLE_SIZE))} on Pro, the fee, returned as usage credit. Also ${usd(instaboxProMonthly(WORKDAY_HOURS))} at Rakazo's ${INSTABOX.size.vcpus} vCPU / ${INSTABOX.size.gb} GB. Free for one computer`,
        "8 hours on the free plan, no cap on paid plans",
        "Memory and disk, when paused",
        "Your cloud on Enterprise",
      ],
    },
    {
      topic: "[Railway](/sandboxes/railway/)",
      cells: [
        "Yes",
        "VM",
        `${aboutUsd(railwayComputerMonthly(WORKDAY_HOURS))}, billed on CPU and memory actually used`,
        "Idle timeout up to 2 hours, or off",
        "Nothing. Rakazo restores the saved workspace",
        "No",
      ],
    },
    {
      topic: "CreateOS",
      cells: [
        "Yes, set up from the computer providers guide",
        "Firecracker microVM",
        `${workday(RATES.createos)} plus disk. Rakazo's default 2 vCPU / 2 GB shape is ${usd(monthly(RATES.createos, WORKDAY_HOURS, CREATEOS_DEFAULT_SHAPE))}`,
        "Not published",
        "Memory and disk, when paused. Both still billed",
        "No",
      ],
    },
    {
      topic: "Modal Sandboxes",
      cells: [
        "No",
        "gVisor, VM runtime optional",
        `${workday(RATES.modal)}. The free plan's $30 monthly credit covers it`,
        "24 hours",
        "Filesystem snapshots. Memory snapshots are in alpha",
        "No",
      ],
    },
    {
      topic: "Vercel Sandbox",
      cells: [
        "No",
        "Firecracker microVM",
        `About ${usd(vercelMonthly(WORKDAY_HOURS, 0.1))} at 10% CPU, ${usd(vercelMonthly(WORKDAY_HOURS, 1))} at full CPU`,
        "45 minutes on Hobby, 24 hours on Pro",
        "Filesystem",
        "No",
      ],
    },
    {
      topic: "Northflank",
      cells: [
        "No",
        "microVM (Kata, Cloud Hypervisor) or gVisor",
        workday(RATES.northflank),
        "No cap",
        "Disk",
        "Your cloud or on-premises",
      ],
    },
    {
      topic: "Blaxel",
      cells: ["No", "microVM", `${workday(RATES.blaxel)}, billed on memory only`, "Not published", "Memory, in standby", "No"],
    },
  ],
  note: `${PRICES_NOTE} Usage only, before free credits, at each provider's default region. Vercel bills CPU only while it is busy, so its price depends on how hard the bot works.`,
};
