import { randomUUID } from "node:crypto";
import type { AdapterContext, SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import {
  inspectNativeHarnessLogin,
  logoutNativeHarnessLogin,
  startNativeHarnessLogin,
  toComputerRef,
} from "@rakazo/adapters";
import type {
  Actor,
  BeginNativeLogin,
  NativeLoginAccount,
  NativeLoginDescriptor,
  NativeLoginState,
} from "@rakazo/contracts";
import {
  BeginNativeLoginInput,
  isNativeLoginVerificationUri,
  NativeLoginDescriptorSchema,
  NativeLoginStateSchema,
  nativeLoginEndpoint,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

type Start = typeof startNativeHarnessLogin;
type Active = { secretId: string; state: NativeLoginState; cancel: () => Promise<void> };

/** Device grants stay in the isolated vendor credential volume, never the API database. */
export function createNativeLogins(deps: {
  prisma: PrismaClient;
  secrets: SecretStore;
  sandbox: SandboxProvider;
  selfHostedEnabled: boolean;
  start?: Start;
  inspect?: typeof inspectNativeHarnessLogin;
  logout?: typeof logoutNativeHarnessLogin;
}) {
  const active = new Map<string, Active>();
  function enabled() {
    if (!deps.selfHostedEnabled)
      throw new Error(
        "Native login requires an explicitly enabled, eligible self-hosted personal deployment.",
      );
  }
  const context = (actor: Actor, botId: string): AdapterContext => ({
    operationId: "native-login",
    traceId: "native-login",
    runId: "native-login",
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  });
  async function computer(actor: Actor, computerId: string) {
    const row = await deps.prisma.computer.findFirst({
      where: { id: computerId, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (!row?.providerRef || row.kind !== "docker")
      throw new IsolationError("The selected computer is unavailable.");
    return toComputerRef(row);
  }
  async function load(actor: Actor, credentialId: string) {
    const credential = await deps.prisma.userModelCredential.findFirst({
      where: { id: credentialId, userId: actor.userId },
    });
    if (!credential) throw new IsolationError();
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret) throw new IsolationError();
    const descriptor = NativeLoginDescriptorSchema.parse(
      JSON.parse(await deps.secrets.load(secret.ciphertext, secret.id)),
    );
    if (
      descriptor.spaceId !== actor.spaceId ||
      credential.provider !== `native-${descriptor.harness}`
    )
      throw new IsolationError();
    return { credential, descriptor };
  }
  async function replace(
    actor: Actor,
    credentialId: string,
    expectedSecretId: string,
    descriptor: NativeLoginDescriptor,
    cleanup?: NativeLoginDescriptor,
  ) {
    const stored = await deps.secrets.put(
      JSON.stringify(descriptor),
      context(actor, "native-login"),
    );
    return deps.prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: stored.id,
          ciphertext: stored.ciphertext,
          userId: actor.userId,
          spaceId: null,
          kind: "model",
        },
      });
      const updated = await tx.userModelCredential.updateMany({
        where: { id: credentialId, userId: actor.userId, secretId: expectedSecretId },
        data: { secretId: stored.id },
      });
      if (updated.count !== 1)
        throw new Error("The native account changed. Reload before continuing.");
      if (cleanup)
        await tx.nativeStateCleanup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            computerId: cleanup.computerId,
            scope: {
              computer: {
                id: cleanup.computerProviderRef,
                providerRef: cleanup.computerProviderRef,
                botId: cleanup.computerHomeKey,
                kind: "docker",
              },
              botId: cleanup.computerHomeKey,
              request: {
                expectedInstallationId: cleanup.installationId,
                credentialScope: {
                  harness: cleanup.harness,
                  connectionId: cleanup.connectionId,
                  epoch: cleanup.epoch,
                },
              },
            },
          },
        });
      // The old descriptor contains no bearer material. Remove it only after the account CAS.
      await tx.secret.deleteMany({ where: { id: expectedSecretId, userId: actor.userId } });
      return stored.id;
    });
  }
  function account(
    credential: { id: string; label: string },
    descriptor: NativeLoginDescriptor,
    state: NativeLoginState,
  ): NativeLoginAccount {
    const safeState = NativeLoginStateSchema.parse(state);
    if (
      safeState.state === "pending" &&
      !isNativeLoginVerificationUri(descriptor.harness, safeState.verificationUri)
    )
      throw new Error("Native login returned an invalid verification address.");
    return {
      credentialId: credential.id,
      endpoint: nativeLoginEndpoint(descriptor),
      label: credential.label,
      harness: descriptor.harness,
      computerId: descriptor.computerId,
      state: safeState,
    };
  }
  async function revoke(
    actor: Actor,
    credentialId: string,
    expectedSecretId?: string,
  ): Promise<NativeLoginAccount> {
    const { credential, descriptor } = await load(actor, credentialId);
    if (expectedSecretId && credential.secretId !== expectedSecretId) {
      const stale = active.get(credentialId);
      if (stale?.secretId === expectedSecretId) {
        active.delete(credentialId);
        await stale.cancel().catch(() => undefined);
      }
      return account(
        credential,
        descriptor,
        descriptor.state === "ready"
          ? { state: "ready", accountLabel: null, plan: null }
          : { state: "failed", code: "unavailable" },
      );
    }
    if (descriptor.state === "disconnected")
      return account(credential, descriptor, { state: "signed_out" });
    const next = { ...descriptor, epoch: randomUUID(), state: "disconnected" as const };
    await replace(actor, credential.id, credential.secretId, next, descriptor);
    const pending = active.get(credential.id);
    active.delete(credential.id);
    await pending?.cancel().catch(() => undefined);
    const ref = {
      id: descriptor.computerProviderRef,
      providerRef: descriptor.computerProviderRef,
      botId: descriptor.computerHomeKey,
      kind: "docker" as const,
    };
    await (deps.logout ?? logoutNativeHarnessLogin)({
      descriptor,
      sandbox: deps.sandbox,
      computer: ref,
      context: context(actor, ref.botId),
    }).catch(() => undefined);
    return account(credential, next, { state: "signed_out" });
  }
  return {
    enabled: deps.selfHostedEnabled,
    async begin(actor: Actor, raw: BeginNativeLogin): Promise<NativeLoginAccount> {
      enabled();
      const input = BeginNativeLoginInput.parse(raw);
      const ref = await computer(actor, input.computerId);
      if (!deps.sandbox.startProcess)
        throw new Error("This computer does not support isolated native login.");
      const installationId = deps.sandbox.nativeStateInstallationId?.();
      if (!installationId)
        throw new Error("This computer cannot identify its private native state namespace.");
      let previous = input.credentialId ? await load(actor, input.credentialId) : null;
      if (
        previous &&
        (previous.descriptor.harness !== input.harness ||
          previous.descriptor.computerId !== input.computerId)
      )
        throw new Error("Reconnect must retain the selected harness and computer.");
      if (previous) {
        await revoke(actor, previous.credential.id);
        previous = await load(actor, previous.credential.id);
      }
      const descriptor: NativeLoginDescriptor = {
        installationId,
        kind: "native_login",
        harness: input.harness,
        connectionId: previous?.descriptor.connectionId ?? randomUUID(),
        epoch: randomUUID(),
        computerId: input.computerId,
        computerProviderRef: ref.providerRef,
        computerHomeKey: ref.botId,
        spaceId: actor.spaceId,
        region: input.region,
        state: "pending",
      };
      let credential: { id: string; label: string; secretId: string };
      if (previous) {
        const secretId = await replace(
          actor,
          previous.credential.id,
          previous.credential.secretId,
          descriptor,
        );
        credential = { ...previous.credential, secretId };
      } else {
        const stored = await deps.secrets.put(
          JSON.stringify(descriptor),
          context(actor, ref.botId),
        );
        credential = await deps.prisma.$transaction(async (tx) => {
          await tx.secret.create({
            data: {
              id: stored.id,
              ciphertext: stored.ciphertext,
              userId: actor.userId,
              spaceId: null,
              kind: "model",
            },
          });
          return tx.userModelCredential.create({
            data: {
              userId: actor.userId,
              provider: `native-${input.harness}`,
              label: input.label,
              secretId: stored.id,
            },
          });
        });
      }
      let handle: Awaited<ReturnType<Start>>;
      try {
        handle = await (deps.start ?? startNativeHarnessLogin)({
          descriptor,
          sandbox: deps.sandbox,
          computer: ref,
          context: context(actor, ref.botId),
        });
      } catch {
        await revoke(actor, credential.id, credential.secretId);
        throw new Error("Native sign-in could not start. Check the computer and try again.");
      }
      let initial: NativeLoginState;
      try {
        const current = await deps.prisma.userModelCredential.findFirst({
          where: { id: credential.id, userId: actor.userId },
        });
        if (current?.secretId !== credential.secretId)
          throw new Error("The native account changed while sign-in was starting.");
        initial = account(credential, descriptor, handle.initial).state;
      } catch {
        // A malformed driver result must not leave an untracked process or grant alive.
        void handle.completion.catch(() => undefined);
        await handle.cancel().catch(() => undefined);
        await revoke(actor, credential.id, credential.secretId);
        throw new Error("Native sign-in returned invalid device instructions.");
      }
      const entry: Active = {
        secretId: credential.secretId,
        state: initial,
        cancel: handle.cancel,
      };
      active.set(credential.id, entry);
      void handle.completion
        .then(async (state) => {
          if (active.get(credential.id) !== entry) return;
          const safeState = NativeLoginStateSchema.parse(state);
          if (safeState.state === "ready") {
            entry.secretId = await replace(actor, credential.id, entry.secretId, {
              ...descriptor,
              state: "ready",
            });
            entry.state = safeState;
            if (active.get(credential.id) === entry) active.delete(credential.id);
          } else {
            await revoke(actor, credential.id, entry.secretId);
          }
        })
        .catch(async () => {
          if (active.get(credential.id) !== entry) return;
          entry.state = { state: "failed", code: "unavailable" };
          await revoke(actor, credential.id, entry.secretId).catch(() => undefined);
        });
      return account(credential, descriptor, entry.state);
    },
    async status(actor: Actor, credentialId: string): Promise<NativeLoginAccount> {
      const { credential, descriptor } = await load(actor, credentialId);
      const pending = active.get(credential.id);
      if (pending && pending.secretId === credential.secretId)
        return account(credential, descriptor, pending.state);
      if (descriptor.state === "disconnected")
        return account(credential, descriptor, { state: "signed_out" });
      enabled();
      const ref = await computer(actor, descriptor.computerId);
      const state = await (deps.inspect ?? inspectNativeHarnessLogin)({
        descriptor,
        sandbox: deps.sandbox,
        computer: ref,
        context: context(actor, ref.botId),
      });
      if (state.state === "signed_out" || state.state === "failed")
        return revoke(actor, credential.id, credential.secretId);
      if (state.state === "ready" && descriptor.state !== "ready")
        await replace(actor, credential.id, credential.secretId, { ...descriptor, state: "ready" });
      return account(credential, descriptor, state);
    },
    async list(actor: Actor) {
      const rows = await deps.prisma.userModelCredential.findMany({
        where: { userId: actor.userId, provider: { in: ["native-codex", "native-kimi"] } },
        orderBy: { createdAt: "asc" },
      });
      const accounts: NativeLoginAccount[] = [];
      for (const row of rows) {
        try {
          const { credential, descriptor } = await load(actor, row.id);
          const pending = active.get(row.id);
          accounts.push(
            account(
              row,
              descriptor,
              (pending?.secretId === credential.secretId ? pending.state : undefined) ??
                (descriptor.state === "ready"
                  ? { state: "ready", accountLabel: null, plan: null }
                  : descriptor.state === "pending"
                    ? { state: "failed", code: "unavailable" }
                    : { state: "signed_out" }),
            ),
          );
        } catch {
          /* Other-space native accounts and invalid descriptors are not exposed. */
        }
      }
      const computers = deps.selfHostedEnabled
        ? await deps.prisma.computer.findMany({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              kind: "docker",
              providerRef: { not: null },
            },
            select: { id: true, scope: true, bots: { select: { name: true }, take: 1 } },
            orderBy: { createdAt: "asc" },
          })
        : [];
      return {
        enabled: deps.selfHostedEnabled,
        accounts,
        computers: computers.map((row) => ({
          id: row.id,
          scope: row.scope === "dedicated" ? ("dedicated" as const) : ("team" as const),
          botName: row.bots[0]?.name ?? null,
        })),
      };
    },
    cancel: revoke,
    logout: revoke,
  };
}
