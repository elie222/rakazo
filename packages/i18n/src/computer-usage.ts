import { i18n } from "@lingui/core";

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
    label:
      computer.scope === "team"
        ? i18n._({ id: "ZrvL3B", message: "Team Computer" })
        : (computer.botName ?? i18n._({ id: "vNFOXs", message: "Private Computer" })),
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
