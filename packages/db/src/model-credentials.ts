import { usableModelId } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export const newestCredentialOrder = [
  { updatedAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

export const newestModelCredentialOrder = newestCredentialOrder;

type ModelCredentialScope = { userId: string; spaceId: string };

export async function selectSpaceModelPreference(
  prisma: Pick<PrismaClient, "spaceModelPreference">,
  scope: ModelCredentialScope,
  credentialId: string,
  modelId: string | null | undefined,
  thinkingLevel?: string | null,
) {
  const persistedModelId = usableModelId(modelId);
  await prisma.spaceModelPreference.updateMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      isDefault: true,
      credentialId: { not: credentialId },
    },
    data: { isDefault: false },
  });
  return prisma.spaceModelPreference.upsert({
    where: {
      spaceId_userId_credentialId: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        credentialId,
      },
    },
    create: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      credentialId,
      modelId: persistedModelId,
      thinkingLevel: thinkingLevel ?? null,
      isDefault: true,
    },
    // The level belongs to the stored modelId, so callers resolve it
    // themselves: pass the existing level to keep it, null to clear it. An
    // omitted level never survives a model change on this write.
    update: {
      modelId: persistedModelId,
      isDefault: true,
      thinkingLevel: thinkingLevel ?? null,
    },
  });
}

function withModelPreference<
  T extends {
    credential: {
      id: string;
      userId: string;
      provider: string;
      label: string;
      secretId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    isDefault: boolean;
    modelId: string | null;
    thinkingLevel: string | null;
  },
>(preference: T) {
  return {
    ...preference.credential,
    isDefault: preference.isDefault,
    defaultModel: usableModelId(preference.modelId),
    thinkingLevel: preference.thinkingLevel,
  };
}

export async function findDefaultModelCredential(
  prisma: PrismaClient,
  scope: ModelCredentialScope,
) {
  const preference = await prisma.spaceModelPreference.findFirst({
    where: { spaceId: scope.spaceId, userId: scope.userId, isDefault: true },
    include: { credential: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return preference ? withModelPreference(preference) : null;
}

export function findNewestUserModelCredential(
  prisma: PrismaClient,
  userId: string,
  provider: string,
) {
  return prisma.userModelCredential.findFirst({
    where: { userId, provider },
    orderBy: newestModelCredentialOrder,
  });
}

type OrderedCredential = {
  id: string;
  provider: string;
  updatedAt: Date;
  createdAt: Date;
};

type OrderedPreference<C extends OrderedCredential> = {
  id: string;
  modelId: string | null;
  thinkingLevel: string | null;
  isDefault: boolean;
  updatedAt: Date;
  credential: C;
};

function compareDescendingId(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function comparePreferenceOrder<C extends OrderedCredential>(
  left: OrderedPreference<C>,
  right: OrderedPreference<C>,
) {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updated !== 0) return updated;
  return compareDescendingId(left.id, right.id);
}

function compareCredentialOrder(left: OrderedCredential, right: OrderedCredential) {
  const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updated !== 0) return updated;
  const created = right.createdAt.getTime() - left.createdAt.getTime();
  if (created !== 0) return created;
  return compareDescendingId(left.id, right.id);
}

/**
 * Credential a save or run would use for this provider and model.
 * A preference whose model id matches wins, then the space's provider preference
 * (default first), then the newest account credential. Unreadable secrets are not skipped.
 */
export function chooseModelCredential<C extends OrderedCredential>(input: {
  provider: string;
  modelId?: string | null;
  preferences: Array<OrderedPreference<C>>;
  credentials: C[];
}):
  | { source: "preference"; preference: OrderedPreference<C> }
  | { source: "credential"; credential: C }
  | null {
  const requestedModelId = usableModelId(input.modelId);
  const preferences = input.preferences
    .filter((preference) => preference.credential.provider === input.provider)
    .sort(comparePreferenceOrder);
  if (requestedModelId) {
    const matching = preferences.find((preference) => preference.modelId === requestedModelId);
    if (matching) return { source: "preference", preference: matching };
  }
  const providerPreference = preferences[0];
  if (providerPreference) return { source: "preference", preference: providerPreference };
  const credential = input.credentials
    .filter((item) => item.provider === input.provider)
    .sort(compareCredentialOrder)[0];
  return credential ? { source: "credential", credential } : null;
}

function appendCredential<C extends OrderedCredential>(
  target: C[],
  seen: Set<string>,
  credential: C,
) {
  if (seen.has(credential.id)) return;
  seen.add(credential.id);
  target.push(credential);
}

/**
 * Credentials to try when saving a space default, best first.
 * The preference that already owns the model is the only candidate.
 * Otherwise the space preference comes first, ahead of a newer unused account.
 */
export function defaultModelCredentialCandidates<C extends OrderedCredential>(input: {
  provider: string;
  modelId?: string | null;
  preferences: Array<OrderedPreference<C>>;
  credentials: C[];
}): C[] {
  const requestedModelId = usableModelId(input.modelId);
  const preferences = input.preferences
    .filter((preference) => preference.credential.provider === input.provider)
    .sort(comparePreferenceOrder);
  const credentials = input.credentials
    .filter((credential) => credential.provider === input.provider)
    .sort(compareCredentialOrder);

  if (requestedModelId) {
    const seen = new Set<string>();
    const owners: C[] = [];
    for (const preference of preferences) {
      if (usableModelId(preference.modelId) !== requestedModelId) continue;
      appendCredential(owners, seen, preference.credential);
    }
    if (owners.length > 0) return owners;
  }

  const spacePreference = preferences[0]?.credential;
  const preferenceByCredentialId = new Map(
    preferences.map((preference) => [preference.credential.id, preference]),
  );
  const replacesSavedModel = (credentialId: string) => {
    const owned = usableModelId(preferenceByCredentialId.get(credentialId)?.modelId);
    return owned !== null && owned !== requestedModelId;
  };
  const seen = new Set<string>();
  const open: C[] = [];
  const replacing: C[] = [];
  const add = (credential: C) => {
    if (spacePreference && credential.id === spacePreference.id) return;
    appendCredential(replacesSavedModel(credential.id) ? replacing : open, seen, credential);
  };
  for (const preference of preferences) add(preference.credential);
  for (const credential of credentials) add(credential);

  const ordered: C[] = [];
  const picked = new Set<string>();
  if (spacePreference) appendCredential(ordered, picked, spacePreference);
  for (const credential of open) appendCredential(ordered, picked, credential);
  for (const credential of replacing) appendCredential(ordered, picked, credential);
  return ordered;
}

function credentialFromChoice<
  C extends OrderedCredential & {
    userId: string;
    label: string;
    secretId: string;
  },
>(choice: ReturnType<typeof chooseModelCredential<C>>) {
  if (!choice) return null;
  if (choice.source === "preference") return withModelPreference(choice.preference);
  return { ...choice.credential, isDefault: false, defaultModel: null, thinkingLevel: null };
}

export async function findModelCredential(
  prisma: PrismaClient,
  scope: ModelCredentialScope,
  provider: string,
  modelId?: string | null,
) {
  if (
    typeof prisma.spaceModelPreference.findMany === "function" &&
    typeof prisma.userModelCredential.findMany === "function"
  ) {
    const [preferences, credentials] = await Promise.all([
      prisma.spaceModelPreference.findMany({
        where: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          credential: { provider },
        },
        include: { credential: true },
      }),
      prisma.userModelCredential.findMany({
        where: { userId: scope.userId, provider },
      }),
    ]);
    return credentialFromChoice(
      chooseModelCredential({ provider, modelId, preferences, credentials }),
    );
  }

  const requestedModelId = usableModelId(modelId);
  // When a helper or bot selects a free-form model, prefer the preference that owns
  // that modelId so runtime uses the same credential the picker advertised.
  if (requestedModelId) {
    const matching = await prisma.spaceModelPreference.findFirst({
      where: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        modelId: requestedModelId,
        credential: { provider },
      },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    if (matching) {
      return credentialFromChoice(
        chooseModelCredential({ provider, modelId, preferences: [matching], credentials: [] }),
      );
    }
  }
  const preference = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      credential: { provider },
    },
    include: { credential: true },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });
  if (preference) {
    return credentialFromChoice(
      chooseModelCredential({ provider, modelId, preferences: [preference], credentials: [] }),
    );
  }
  const credential = await findNewestUserModelCredential(prisma, scope.userId, provider);
  return credentialFromChoice(
    chooseModelCredential({
      provider,
      modelId,
      preferences: [],
      credentials: credential ? [credential] : [],
    }),
  );
}
