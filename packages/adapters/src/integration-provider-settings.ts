import type { AdapterContext, ConnectorCall, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import {
  type IntegrationProviderConfig,
  IntegrationProviderConfigSchema,
  type IntegrationProviderId,
  IntegrationProviderIdSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { ComposioConnector } from "./composio-connector.js";
import { PipedreamConnector } from "./pipedream-connector.js";
import type { EncryptedSecretStore } from "./secrets.js";

/** Resolve persisted credentials on every operation so API and workers observe changes.
 * Cache adapters by ciphertext to preserve sessions without retaining old credentials. */
export class IntegrationProviderSettings {
  private readonly cache = new Map<
    string,
    { ciphertext: string; adapter: ManagedConnectorProvider }
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly identitySecret: string,
    private readonly fallbacks: Partial<
      Record<IntegrationProviderId, ManagedConnectorProvider>
    > = {},
    private readonly factory?: (config: IntegrationProviderConfig) => ManagedConnectorProvider,
  ) {}

  private create(config: IntegrationProviderConfig): ManagedConnectorProvider {
    if (this.factory) return this.factory(config);
    return config.provider === "composio"
      ? new ComposioConnector(config.apiKey)
      : new PipedreamConnector({ ...config, identitySecret: this.identitySecret });
  }

  async configured(id: IntegrationProviderId): Promise<boolean> {
    return (
      Boolean(
        await this.prisma.integrationProviderConfig.findUnique({
          where: { id },
          select: { id: true },
        }),
      ) || Boolean(this.fallbacks[id])
    );
  }

  async resolve(id: IntegrationProviderId): Promise<ManagedConnectorProvider | undefined> {
    const row = await this.prisma.integrationProviderConfig.findUnique({ where: { id } });
    if (!row) {
      this.cache.delete(id);
      return this.fallbacks[id];
    }
    const cached = this.cache.get(id);
    if (cached?.ciphertext === row.ciphertext) return cached.adapter;
    const config = IntegrationProviderConfigSchema.parse(
      JSON.parse(this.secrets.load(row.ciphertext, `integration-provider:${id}`)),
    );
    if (config.provider !== id)
      throw new Error("Integration provider configuration does not match");
    const adapter = this.create(config);
    this.cache.set(id, { ciphertext: row.ciphertext, adapter });
    return adapter;
  }

  async save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void> {
    const adapter = this.create(config);
    try {
      // Exercises authenticated access before replacing working credentials.
      await adapter.listConnectedExternalIds(context);
    } catch {
      // Provider errors can contain credentials or account details.
      throw new Error("Could not verify these credentials");
    }
    const stored = await this.secrets.put(
      JSON.stringify(config),
      context,
      `integration-provider:${config.provider}`,
    );
    await this.prisma.integrationProviderConfig.upsert({
      where: { id: config.provider },
      create: { id: config.provider, ciphertext: stored.ciphertext },
      update: { ciphertext: stored.ciphertext },
    });
    this.cache.set(config.provider, { ciphertext: stored.ciphertext, adapter });
  }

  providers(): ManagedConnectorProvider[] {
    return IntegrationProviderIdSchema.options.map(
      (id) => new ConfiguredIntegrationProvider(id, this),
    );
  }

  /** Warm catalogs for env- and DB-configured providers. Fire-and-forget. */
  warmDirectories(): void {
    for (const id of IntegrationProviderIdSchema.options) {
      void this.resolve(id)
        .then((provider) => provider?.warmDirectory?.())
        .catch(() => undefined);
    }
  }
}

class ConfiguredIntegrationProvider implements ManagedConnectorProvider {
  constructor(
    private readonly id: IntegrationProviderId,
    private readonly settings: IntegrationProviderSettings,
  ) {}
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  private async required() {
    const provider = await this.settings.resolve(this.id);
    if (!provider) throw new Error("Set up an integration provider in Integrations first");
    return provider;
  }
  async catalog(context: AdapterContext, query?: string) {
    return (await this.settings.resolve(this.id))?.catalog(context, query) ?? [];
  }
  async discoverTools(context: AdapterContext) {
    return (await this.settings.resolve(this.id))?.discoverTools(context) ?? [];
  }
  async listConnectedExternalIds(context: AdapterContext) {
    return (await this.settings.resolve(this.id))?.listConnectedExternalIds(context) ?? [];
  }
  async connectionReady(context: AdapterContext, externalId: string) {
    return (await this.required()).connectionReady(context, externalId);
  }
  async begin(request: Parameters<ManagedConnectorProvider["begin"]>[0], context: AdapterContext) {
    return (await this.required()).begin(request, context);
  }
  async complete(
    request: Parameters<ManagedConnectorProvider["complete"]>[0],
    context: AdapterContext,
  ) {
    return (await this.required()).complete(request, context);
  }
  async revoke(ref: string, context: AdapterContext) {
    return (await this.required()).revoke(ref, context);
  }
  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    return (await this.required()).resolveCall?.(call, context);
  }
  async *execute(call: ConnectorCall, context: AdapterContext) {
    yield* (await this.required()).execute(call, context);
  }
}
