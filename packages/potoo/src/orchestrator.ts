import type { Report } from "./contracts.js";
import { parseReport } from "./contracts.js";
import type { PatrolParams } from "./prompts.js";
import {
  buildEscalationSystem,
  buildEscalationUser,
  buildPatrolSystem,
  buildPatrolUser,
  buildRepairSystem,
  buildRepairUser,
  ESCALATION_TEMPERATURE,
  PATROL_TEMPERATURE,
} from "./prompts.js";

export type FlightKind = "patrol" | "escalation";

export type AssembledFlight = {
  kind: FlightKind;
  system: string;
  user: string;
  temperature: number;
};

export function assemblePatrolFlight(beatBrief: string, params: PatrolParams): AssembledFlight {
  return {
    kind: "patrol",
    system: buildPatrolSystem(beatBrief),
    user: buildPatrolUser(params),
    temperature: PATROL_TEMPERATURE,
  };
}

export function assembleEscalationFlight(patrolJson: string, transcript: string): AssembledFlight {
  return {
    kind: "escalation",
    system: buildEscalationSystem(),
    user: buildEscalationUser(patrolJson, transcript),
    temperature: ESCALATION_TEMPERATURE,
  };
}

export function assembleRepairFlight(original: AssembledFlight): AssembledFlight {
  return {
    kind: original.kind,
    system: buildRepairSystem(original.system),
    user: buildRepairUser(),
    temperature: original.temperature,
  };
}

export type FlightRecord = {
  kind: FlightKind;
  beatName: string;
  repaired: boolean;
  report: Report | null;
  record: string;
};

export function fileFlight(
  original: AssembledFlight,
  beatName: string,
  firstReply: string,
  repairReply?: string,
): FlightRecord {
  const first = parseReport(firstReply);
  if (first) {
    return { kind: original.kind, beatName, repaired: false, report: first, record: first.record };
  }
  if (repairReply === undefined) {
    return {
      kind: original.kind,
      beatName,
      repaired: false,
      report: null,
      record: "copy unfiled: missing json block, repair not attempted",
    };
  }
  const repaired = parseReport(repairReply);
  if (repaired) {
    return {
      kind: original.kind,
      beatName,
      repaired: true,
      report: repaired,
      record: repaired.record,
    };
  }
  return {
    kind: original.kind,
    beatName,
    repaired: true,
    report: null,
    record: "copy unfiled after single repair: missing or malformed json block",
  };
}

export function hasHighSeverity(report: Report): boolean {
  return report.findings.some((finding) => finding.severity === "high");
}
