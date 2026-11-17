import { createHash } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { MnemoverseConnectionConfig } from "./mnemoverse-client.js";
import {
  deleteMnemoverseAtom,
  getMnemoverseAtomDomain,
  probeMnemoverse,
  readMnemoverse,
  writeMnemoverse,
} from "./mnemoverse-client.js";

export const MNEMOVERSE_PROVIDER_ID = "mnemoverse";

/** Mnemoverse atom ids are UUIDs; anything else could change the path a lookup is sent to. */
const ATOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mnemoverse refuses a domain name longer than this. */
const MAX_DOMAIN_CHARS = 100;

function requiredKey(credentials: Record<string, string>): string {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("apiKey is required");
  if (apiKey.length < 8) throw new Error("apiKey must contain at least 8 characters");
  // The key goes into a header, and a runtime that refuses a bad header quotes it in its error.
  if (!/^[\x21-\x7e]+$/.test(apiKey))
    throw new Error("apiKey must be printable text without spaces");
  return apiKey;
}

export async function prepareMnemoverseConnection(
  _settings: Record<string, string>,
  credentials: Record<string, string>,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const apiKey = requiredKey(credentials);
  const probe = await probeMnemoverse({ apiKey });
  if (!probe.ok) throw new Error(probe.error);
  return { settings: {}, credentials: { apiKey } };
}

export function createMnemoverseProvider(
  _settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return new MnemoverseMemoryProvider({ apiKey: requiredKey(credentials) });
}

/** A namespace this build owns, kept within the length Mnemoverse accepts. */
function domainName(prefix: string, id: string): string {
  const name = `${prefix}${id}`;
  return name.length <= MAX_DOMAIN_CHARS
    ? name
    : `${prefix}${createHash("sha256").update(id).digest("hex")}`;
}

function isolatedDomain(botId: string): string {
  return domainName("rakazo:bot:", botId);
}

function sharedDomain(spaceId: string): string {
  return domainName("rakazo:space:", spaceId);
}

/** Where a save goes: the bot's own domain, and with the Shared scope the Space's as well. */
function saveDomains(scope: DurableMemoryScope, botId: string, spaceId: string): string[] {
  return scope === "shared"
    ? [isolatedDomain(botId), sharedDomain(spaceId)]
    : [isolatedDomain(botId)];
}

/** Everything a bot may read or forget. A shared bot still sees what it saved on its own. */
function recallDomains(scope: DurableMemoryScope, botId: string, spaceId: string): string[] {
  return scope === "shared"
    ? [sharedDomain(spaceId), isolatedDomain(botId)]
    : [isolatedDomain(botId)];
}

export class MnemoverseMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly connection: MnemoverseConnectionConfig) {}

  describe() {
    return {
      id: MNEMOVERSE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      } as const,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    // Mnemoverse rejects an empty query.
    const query = request.query.trim();
    if (!query) return { ok: true, value: [] };
    const domains = recallDomains(request.scope, request.botId, context.spaceId);
    const responses = await Promise.all(
      domains.map((domain) =>
        readMnemoverse(this.connection, query, domain, request.limit, context.signal),
      ),
    );
    const failures: string[] = [];
    const failedDomains: Array<{ domain: string; error: string }> = [];
    const byAtom = new Map<string, SemanticMemoryResult>();
    for (const [index, response] of responses.entries()) {
      if (!response.ok) {
        failures.push(response.error);
        failedDomains.push({ domain: domains[index]!, error: response.error });
        continue;
      }
      for (const item of response.value) {
        byAtom.set(item.atomId, {
          memory: item.content,
          score: item.relevance,
          id: item.atomId,
          provenance: "mnemoverse",
          entity: item.domain,
        });
      }
    }
    // One namespace answering is enough to recall from; none answering is a failure.
    if (failures.length === responses.length) return { ok: false, error: failures.join("; ") };
    if (failures.length > 0) {
      getLogger().warn("Mnemoverse recall is missing a domain that did not answer", {
        failed: failedDomains,
      });
    }
    // A shared fact is saved in both domains: list it once, the better-scored copy first.
    const seen = new Set<string>();
    const value = [...byAtom.values()]
      .sort((a, b) => b.score - a.score)
      .filter((item) => {
        const text = item.memory.trim();
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
      })
      .slice(0, request.limit);
    return { ok: true, value };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Compaction summaries stay in Rakazo; Mnemoverse holds durable facts only.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    const domains = saveDomains(request.scope, request.botId, context.spaceId);
    const writes = await Promise.all(
      domains.map((domain) =>
        writeMnemoverse(this.connection, request.content, domain, context.signal),
      ),
    );
    const written = writes.filter((write) => write.ok).length;
    const failed = writes.flatMap((write) =>
      !write.ok && !("duplicate" in write) ? [write.error] : [],
    );
    if (failed.length > 0) {
      const error = [...new Set(failed)].join("; ");
      return {
        ok: false,
        error: written > 0 ? `Saved to one domain but not all: ${error}. Retrying is safe.` : error,
      };
    }
    // A copy refused as too close to one already there (a retry after a half-finished save, or a
    // near match) does not hide a copy that was written. Refused everywhere is not saved.
    if (written > 0) return { ok: true, value: undefined };
    const refused = writes[0];
    return { ok: false, error: refused && !refused.ok ? refused.error : "Mnemoverse save failed." };
  }

  async purgeHistory(
    _request: SemanticMemoryPurgeHistoryRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Mnemoverse.
    return { ok: true, value: undefined };
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const id = request.id.trim();
    if (!id) return { ok: false, error: "id is required" };
    if (!ATOM_ID_PATTERN.test(id)) return { ok: false, error: "Invalid Mnemoverse memory id." };
    const allowed = recallDomains(request.scope, request.botId, context.spaceId);
    if (request.entity && !allowed.includes(request.entity)) {
      return { ok: false, error: "That memory belongs to another bot or Space." };
    }
    // The key reaches every memory in the account, so delete only an atom confirmed to sit in a
    // namespace this bot can recall, and fail closed when that cannot be shown.
    const found = await getMnemoverseAtomDomain(this.connection, id, context.signal);
    if (!found.ok) return found;
    if (found.value === null || !allowed.includes(found.value)) {
      return { ok: false, error: "No memory with that id was found in this bot's memory." };
    }
    const removed = await deleteMnemoverseAtom(this.connection, id, context.signal);
    if (!removed.ok) return removed;
    return { ok: true, value: { id, expired: true, reason: request.reason ?? null } };
  }
}
