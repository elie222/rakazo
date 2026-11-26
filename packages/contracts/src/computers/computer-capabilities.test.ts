import { describe, expect, it } from "vitest";
import { ComputerCapabilitiesSchema, ComputerStatusSchema } from "./computer.js";

const capabilities = {
  version: 1,
  search: "service_path",
  programs: { git: "available", libreoffice: "not_on_path" },
  memory: {
    currentBytes: 1,
    workingSetBytes: 2,
    limitBytes: 3,
    oomKills: 0,
    pressure: "normal",
  },
  display: { width: 1280, height: 800, scale: 1 },
  perception: { atspi: true, cdp: true, hitTest: true, settle: true, zoom: true },
  stream: { protocol: "vnc", quality: false },
  recording: false,
  desktopApps: false,
} as const;

const status = {
  botId: "bot",
  mode: "team",
  kind: "docker",
  state: "running",
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: null,
  canUpdate: true,
  terminalAvailable: true,
} as const;

describe("ComputerCapabilitiesSchema", () => {
  it("parses a full report", () => {
    expect(ComputerCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  it("rejects an unknown stream protocol", () => {
    expect(
      ComputerCapabilitiesSchema.safeParse({
        ...capabilities,
        stream: { protocol: "ftp", quality: false },
      }).success,
    ).toBe(false);
  });

  it("rejects negative memory and an unknown program state", () => {
    expect(
      ComputerCapabilitiesSchema.safeParse({
        ...capabilities,
        memory: { ...capabilities.memory, currentBytes: -1 },
      }).success,
    ).toBe(false);
    expect(
      ComputerCapabilitiesSchema.safeParse({
        ...capabilities,
        programs: { git: "installed" },
      }).success,
    ).toBe(false);
  });

  it("keeps older status payloads compatible when capabilities are absent", () => {
    expect(ComputerStatusSchema.parse(status)).toEqual(status);
  });

  it("reads capabilities from a status payload when the server provides them", () => {
    expect(ComputerStatusSchema.parse({ ...status, capabilities }).capabilities).toEqual(
      capabilities,
    );
  });
});
