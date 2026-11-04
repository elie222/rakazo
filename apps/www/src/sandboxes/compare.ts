import type { ArticleTable } from "../provider-article/types";
import { PRICES_NOTE } from "./shared";

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
    "88 hours at 2 vCPU / 4 GB",
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
        "$20 minimum. Rakazo's 4 vCPU / 8 GB size uses $3.17 of it",
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
        "$14.57, or $164.57 with the Pro plan",
        "1 hour on Hobby, 24 hours on Pro",
        "Memory and disk, when paused",
        "Open source (Apache-2.0). Your cloud on Enterprise",
      ],
    },
    {
      topic: "[Daytona](/sandboxes/daytona/)",
      cells: [
        "Yes",
        "Containers by default, VMs available",
        "$14.57",
        "No cap",
        "Disk. Memory only on VM sandboxes",
        "Closed source since June 2026. Your cloud on Enterprise",
      ],
    },
    {
      topic: "[Novita](/sandboxes/novita/)",
      cells: ["Yes", "Not stated", "$10.26", "1 hour free, 24 hours paid", "Memory and disk, when paused", "No"],
    },
    {
      topic: "[Railway](/sandboxes/railway/)",
      cells: [
        "Yes",
        "VM",
        "About $18, billed on CPU and memory actually used",
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
        "$11.59. Rakazo's default 2 vCPU / 2 GB shape is $8.40",
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
        "$20.94. The free plan's $30 monthly credit covers it",
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
        "About $9.71 at 10% CPU, $29.99 at full CPU",
        "45 minutes on Hobby, 24 hours on Pro",
        "Filesystem",
        "No",
      ],
    },
    {
      topic: "Northflank",
      cells: ["No", "microVM (Kata, Cloud Hypervisor) or gVisor", "$5.87", "No cap", "Disk", "Your cloud or on-premises"],
    },
    {
      topic: "Blaxel",
      cells: ["No", "microVM", "$14.57, billed on memory only", "Not published", "Memory, in standby", "No"],
    },
  ],
  note: `${PRICES_NOTE} Usage only, before free credits, at each provider's default region. Vercel bills CPU only while it is busy, so its price depends on how hard the bot works.`,
};
