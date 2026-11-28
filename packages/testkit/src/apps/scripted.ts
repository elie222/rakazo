import type { AppEmulatorOptions, AppTool } from "./app-emulator.js";
import { AppEmulator } from "./app-emulator.js";

export type ScriptedTool = {
  name: string;
  description: string;
  readOnly?: boolean;
  /** What every call returns, whatever its arguments. */
  result: unknown;
};

/** A server whose tools each answer one fixed result, for cases about which tool a bot reaches. */
export class ScriptedEmulator extends AppEmulator {
  readonly kind: string;
  constructor(
    readonly displayName: string,
    private readonly scripted: ScriptedTool[],
    options: AppEmulatorOptions,
  ) {
    super(options);
    this.kind = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  tools(): AppTool[] {
    return this.scripted.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties: {} },
      readOnly: tool.readOnly ?? true,
      run: () => structuredClone(tool.result),
    }));
  }
}
