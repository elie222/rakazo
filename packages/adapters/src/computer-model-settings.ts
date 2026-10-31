import type { AgentRunModel } from "@rakazo/adapter-kit";
import type { ComputerModelSelection } from "@rakazo/contracts";
import { ComputerModelSelectionSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { settingsTarget } from "@rakazo/db";
import { modelAcceptsImageInput } from "./model-vision.js";
import { restoreTurnCheckpoint } from "./turn-checkpoint.js";

type Scope = { userId: string; spaceId: string };
type Resolve = (
  provider: string,
  id: string,
  connectionId: string,
  thinkingLevel?: string,
) => Promise<AgentRunModel>;
/** Connection-local defaults: never borrow another account's preference or credentials. */
export async function resolveComputerRunModel(
  deps: { prisma: PrismaClient; resolve: Resolve },
  scope: Scope,
  main: AgentRunModel,
  override: unknown,
): Promise<AgentRunModel | undefined> {
  const selection = ComputerModelSelectionSchema.parse(override ?? null);
  if (selection?.mode === "main") return undefined;
  let choice: ComputerModelSelection = selection;
  if (!choice) {
    if (!main.connectionId) return undefined;
    const target = await settingsTarget(deps.prisma, scope, "models");
    const preference =
      target === "space"
        ? await deps.prisma.spaceModelPreference.findFirst({
            where: {
              userId: scope.userId,
              spaceId: scope.spaceId,
              credentialId: main.connectionId,
            },
          })
        : await deps.prisma.userModelPreference.findFirst({
            where: { userId: scope.userId, credentialId: main.connectionId },
          });
    if (!preference?.computerModelId) return undefined;
    choice = ComputerModelSelectionSchema.parse({
      mode: "model",
      provider: preference.computerProvider ?? main.provider,
      credentialId: preference.computerCredentialId ?? main.connectionId,
      modelId: preference.computerModelId,
      thinkingLevel: preference.computerThinkingLevel ?? null,
    });
  }
  if (choice?.mode !== "model") return undefined;
  const model = await deps.resolve(
    choice.provider,
    choice.modelId,
    choice.credentialId,
    choice.thinkingLevel ?? "medium",
  );
  if (
    model.provider !== choice.provider ||
    model.id !== choice.modelId ||
    model.connectionId !== choice.credentialId
  )
    throw new Error("Computer model connection is no longer available");
  if (
    !modelAcceptsImageInput(model.provider, model.id, model.acceptsImages) ||
    model.acceptsImages === false
  )
    throw new Error("Computer model must support image input");
  return model;
}

/** A stored checkpoint is authority for its two identities, not for arbitrary connections. */
export function computerCheckpointResolver(
  blob: string | undefined,
  main: AgentRunModel,
  resolve: Resolve,
) {
  if (!blob) return undefined;
  // Legacy checkpoint compatibility/replay stays with the executor's existing policy.
  let envelope: unknown;
  try {
    envelope = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (!envelope || typeof envelope !== "object" || !("computerMode" in envelope)) return undefined;
  const state = restoreTurnCheckpoint(blob, main).computerMode;
  if (!state) return undefined;
  const has = (provider: string, id: string, connectionId?: string) =>
    [state.main, state.computer].some(
      (pin) => pin.provider === provider && pin.id === id && pin.connectionId === connectionId,
    );
  const resolver = async (provider: string, id: string, connectionId?: string) => {
    const pin = [state.main, state.computer].find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.id === id &&
        candidate.connectionId === connectionId,
    );
    if (!pin || !connectionId)
      throw new Error("Computer model checkpoint requires its pinned connection");
    const model = await resolve(provider, id, connectionId, pin.thinkingLevel ?? undefined);
    if (
      model.connectionId !== connectionId ||
      model.provider !== provider ||
      model.id !== id ||
      (model.oauth ? "oauth" : "api-key") !== pin.auth
    )
      throw new Error("Pinned computer mode model is unavailable");
    return model;
  };
  return Object.assign(resolver, {
    has,
    hasModel: (provider: string, id: string) =>
      [state.main, state.computer].some((pin) => pin.provider === provider && pin.id === id),
  });
}
