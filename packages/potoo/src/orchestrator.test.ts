import { describe, expect, it } from "vitest";
import {
  assembleEscalationFlight,
  assemblePatrolFlight,
  assembleRepairFlight,
  fileFlight,
  hasHighSeverity,
} from "./orchestrator.js";
import { ESCALATION_TEMPERATURE, P1_NEWSROOM_FRAME, PATROL_TEMPERATURE } from "./prompts.js";

describe("flight assembly", () => {
  it("assembles patrol as P1 + beat + contract at 0.2", () => {
    const flight = assemblePatrolFlight("Beat brief.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "investigation",
    });
    expect(flight.temperature).toBe(PATROL_TEMPERATURE);
    expect(PATROL_TEMPERATURE).toBe(0.2);
    expect(flight.system.startsWith(P1_NEWSROOM_FRAME)).toBe(true);
    expect(flight.system).toContain("Beat brief.");
    expect(flight.system).toContain("findings");
    expect(flight.user).toContain("/home/potoo/repo");
  });

  it("assembles escalation at 0.3 with report plus transcript", () => {
    const flight = assembleEscalationFlight('{"findings": []}', "tool log");
    expect(flight.temperature).toBe(ESCALATION_TEMPERATURE);
    expect(ESCALATION_TEMPERATURE).toBe(0.3);
    expect(flight.user).toContain("tool log");
  });

  it("repair reuses the original system exactly once", () => {
    const original = assemblePatrolFlight("Beat.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "bug-fix",
    });
    const repair = assembleRepairFlight(original);
    expect(repair.system).toBe(original.system);
    expect(repair.temperature).toBe(original.temperature);
  });
});

describe("filing", () => {
  it("files first reply without repair", () => {
    const original = assemblePatrolFlight("Beat.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "investigation",
    });
    const record = fileFlight(
      original,
      "investigation",
      '```json\n{"findings": [], "back_page": [], "record": "quiet"}\n```',
    );
    expect(record.repaired).toBe(false);
    expect(record.report?.findings).toEqual([]);
  });

  it("logs a single repair and stops asking", () => {
    const original = assemblePatrolFlight("Beat.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "investigation",
    });
    const record = fileFlight(
      original,
      "investigation",
      "prose without a block",
      '```json\n{"findings": [], "back_page": [], "record": "quiet after repair"}\n```',
    );
    expect(record.repaired).toBe(true);
    expect(record.report?.record).toContain("repair");
  });

  it("gates escalation on high severity", () => {
    expect(hasHighSeverity({ findings: [], back_page: [], record: "quiet" })).toBe(false);
    expect(
      hasHighSeverity({
        findings: [
          {
            title: "auth tokens expire early",
            body: "broke",
            evidence: [],
            confidence: "confirmed",
            severity: "high",
          },
        ],
        back_page: [],
        record: "front page",
      }),
    ).toBe(true);
  });
});
