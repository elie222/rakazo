import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { BillingStatus, ComputerMode, ComputerSize } from "@rakazo/contracts";
import { COMPUTER_SIZE_SPECS, SANDBOX_SIZE_HOURLY_COST_MICROS } from "@rakazo/contracts";

export function tierComputerDescription(offer: NonNullable<BillingStatus["byokTiers"]>[number]) {
  const { vcpus, memoryGb } = COMPUTER_SIZE_SPECS[offer.computerSize];
  const hours = offer.computerHours;
  return offer.computerSizeChoice
    ? t`Up to ${vcpus} vCPU and ${memoryGb} GB, ${hours} Standard computer hours a month`
    : t`${vcpus} vCPU, ${memoryGb} GB, ${hours} computer hours a month`;
}

export function tierComputerSummary(offer: NonNullable<BillingStatus["byokTiers"]>[number]) {
  if (!offer.computerSizeChoice) return tierComputerDescription(offer);
  const hours = new Intl.NumberFormat(i18n.locale || "en").format(offer.computerHours);
  if (offer.computerSize === "standard") return t`${hours} bot computer hours/month`;
  const size = offer.computerSize === "large" ? t`Large` : t`Extra large`;
  return t`${hours} bot computer hours/month at Standard size · Up to ${size}`;
}

/** The size's name with how many times faster than Standard it uses computer hours. */
export function computerSizeLabel(size: ComputerSize): string {
  const rate = SANDBOX_SIZE_HOURLY_COST_MICROS[size] / SANDBOX_SIZE_HOURLY_COST_MICROS.standard;
  switch (size) {
    case "standard":
      return t`Standard`;
    case "large":
      return t`Large (uses ${rate}× hours)`;
    case "xlarge":
      return t`Extra large (uses ${rate}× hours)`;
  }
}

/** A Space's Team Computer, or a private computer by the bot it belongs to. */
export function computerName(computer: { scope: "team" | "dedicated"; botName: string | null }) {
  return computer.scope === "team"
    ? i18n._({ id: "ZrvL3B", message: "Team Computer" })
    : (computer.botName ?? i18n._({ id: "vNFOXs", message: "Private Computer" }));
}

/** The computer a bot works on: its own, or the Space's Team Computer. */
export function computerLabel(mode: ComputerMode | undefined, name: string) {
  return mode === "dedicated" ? t`${name}’s computer` : t`Team Computer`;
}

type UsageRead = {
  isError: boolean;
  data?: {
    computers: Array<{
      id: string;
      scope: "team" | "dedicated";
      botName: string | null;
      hours: number;
    }>;
    otherHours: number;
  };
};

// Keep the macro-generated catalog IDs when translating from shared code.
export function computerUsageDetails({ data, isError }: UsageRead, locale: string) {
  if (isError) {
    return {
      rows: [],
      message: i18n._({
        id: "q3CARk",
        message: "Could not load computer hours",
      }),
    };
  }
  if (!data) return { rows: [], message: i18n._({ id: "Pwqkdw", message: "Loading…" }) };

  const hours = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "hour",
    maximumFractionDigits: 1,
  });
  const rows = data.computers.map((computer) => ({
    id: computer.id,
    label: computerName(computer),
    hours: hours.format(computer.hours),
  }));
  if (data.otherHours > 0) {
    rows.push({
      id: "other",
      label: i18n._({ id: "AF1-_j", message: "Other computers" }),
      hours: hours.format(data.otherHours),
    });
  }
  return {
    rows,
    message: rows.length ? null : i18n._({ id: "AoKGLY", message: "No computer hours used yet" }),
  };
}
