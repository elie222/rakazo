import { ORPCError } from "@orpc/server";
import type { CodexLiveCatalog, parseModelSecret } from "@rakazo/adapters";
import { findConnectedModelCredential, validateConnectedModelChoice } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, usableModelId } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/** The actor's active compatible bot, routine and backup pins matching `filter`. */
async function compatibleModelPins(
  deps: RouterDeps,
  actor: Actor,
  filter: { spaceId?: string; modelId: string | { notIn: string[] } },
) {
  const provider = OPENAI_COMPATIBLE_PROVIDER_ID;
  const where = { userId: actor.userId, ...filter };
  const pin = { spaceId: true, modelId: true } as const;
  // A connection is the account's, so its pins are checked in every Space it is used in.
  const [bots, routines, roleChoices] = await runAsSystem(
    "model pins across the account's Spaces",
    () =>
      Promise.all([
        deps.prisma.bot.findMany({
          where: { ...where, archivedAt: null, modelProvider: provider },
          select: { ...pin, name: true },
        }),
        deps.prisma.routine.findMany({
          where: { ...where, modelProvider: provider, bot: { archivedAt: null } },
          select: { ...pin, name: true },
        }),
        deps.prisma.spaceModelRoleChoice.findMany({
          where: { ...where, provider },
          select: { ...pin, role: true, position: true, credentialId: true },
        }),
      ]),
  );
  return { named: [...bots, ...routines], backups: roleChoices };
}

type ModelPinRow = { spaceId: string; modelId: string | null; credentialId?: string | null };

/** Refusal naming the bots and routines (plus "backup models") left on a dropped model. */
function refuseModelPins(
  pins: { named: Array<ModelPinRow & { name: string }>; backups: ModelPinRow[] },
  dangling: (row: ModelPinRow) => boolean,
) {
  const names = pins.named.filter(dangling).map((row) => row.name);
  if (pins.backups.some(dangling)) names.push("backup models");
  if (names.length === 0) return;
  throw new ORPCError("BAD_REQUEST", {
    message: `In use by ${[...new Set(names)].join(", ")}. Pick another model for them first.`,
  });
}

/** Refuse only pins that runtime selection cannot serve after this connection save. */
export async function assertNoDanglingModelPins(
  deps: RouterDeps,
  actor: Actor,
  connection: { id: string },
  secret: ReturnType<typeof parseModelSecret>,
  actorDefault: string,
) {
  const stored = secret.kind === "openai_compatible" ? (secret.enabledModelIds ?? []) : [];
  const [preferences, pins] = await Promise.all([
    deps.prisma.spaceModelPreference.findMany({
      where: {
        userId: actor.userId,
        credential: { userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      },
      select: { spaceId: true, modelId: true, credentialId: true },
    }),
    compatibleModelPins(deps, actor, { modelId: { notIn: stored } }),
  ]);
  const defaults = new Map(
    preferences
      .filter((row) => row.credentialId === connection.id)
      .map((row) => [row.spaceId, usableModelId(row.modelId)]),
  );
  defaults.set(actor.spaceId, usableModelId(actorDefault));
  const dangling = new Set<ModelPinRow>();
  for (const row of [...pins.named, ...pins.backups] as ModelPinRow[]) {
    if (!row.modelId || row.modelId === defaults.get(row.spaceId)) continue;
    // A row pinned to a connection runs only there.
    if (row.credentialId) {
      if (row.credentialId === connection.id) dangling.add(row);
      continue;
    }
    const selected = await findConnectedModelCredential(
      deps.prisma,
      deps.secrets,
      { ...actor, spaceId: row.spaceId },
      OPENAI_COMPATIBLE_PROVIDER_ID,
      row.modelId,
      {
        replacement: {
          credentialId: connection.id,
          secret,
          defaultModel: defaults.get(row.spaceId) ?? null,
        },
      },
    );
    if (selected?.id === connection.id || !selected) dangling.add(row);
  }
  refuseModelPins(pins, (row) => dangling.has(row));
}

/**
 * `models.setDefault` on an openai-compatible connection: a listed secret only accepts an
 * effective id. It changes only this space's default and never the secret, so the only pins
 * it can strand are this space's pins on an outgoing default that is outside the stored list.
 */
export async function assertCompatibleDefaultChange(
  deps: RouterDeps,
  actor: Actor,
  modelId: string,
  thinking: { enabledModelIds?: string[]; storedEnabledModelIds?: string[] },
) {
  const requested = modelId.trim();
  const enabled = thinking.enabledModelIds ?? [];
  const stored = thinking.storedEnabledModelIds;
  if (stored && !enabled.includes(requested)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
  }
  const outgoing = enabled.find((id) => id !== requested && !stored?.includes(id));
  if (!outgoing) return;
  const pins = await compatibleModelPins(deps, actor, {
    spaceId: actor.spaceId,
    modelId: outgoing,
  });
  // The main model's own row is the choice being replaced, not a pin left behind.
  refuseModelPins(
    {
      ...pins,
      backups: pins.backups.filter((row) => !(row.role === "main" && row.position === 0)),
    },
    () => true,
  );
}

/** A routine may only name a model the space has connected. */
export async function assertRoutineModel(
  deps: RouterDeps,
  actor: Actor,
  model: { modelProvider?: string | null; modelId?: string | null },
  codexCatalog: CodexLiveCatalog,
) {
  if (!model.modelProvider || !model.modelId) return;
  const message = await validateConnectedModelChoice(
    deps.prisma,
    deps.secrets,
    actor,
    model.modelProvider,
    model.modelId,
    { codexCatalog },
  );
  if (message) throw new ORPCError("BAD_REQUEST", { message });
}
