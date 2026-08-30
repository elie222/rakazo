import type { SopDefinition } from "@rakazo/contracts";

export function validateSopDefinition(def: SopDefinition): void {
  if (!def.trigger?.trim()) throw new Error("SOP trigger required");
  if (!def.steps || def.steps.length === 0) throw new Error("SOP must have at least one step");
  if (def.steps.length > 20) throw new Error("SOP exceeds max steps");
  for (const step of def.steps) {
    if (!step.instruction?.trim()) throw new Error("SOP step instruction required");
    if (!["create_work", "assign", "review", "approval", "notify", "custom"].includes(step.type)) {
      throw new Error(`Unknown SOP step type ${step.type}`);
    }
  }
}

export function validateSopName(name: string): void {
  if (!name.trim() || name.trim().length > 120) throw new Error("Invalid SOP name");
}
