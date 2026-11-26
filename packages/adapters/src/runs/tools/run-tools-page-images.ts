import type { PageImages } from "@rakazo/contracts";
import { PAGE_IMAGE_NAME, PAGE_IMAGES_MAX } from "@rakazo/contracts";
import { resolveActionApprovalDetail, siteAlwaysAllowed } from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import type { Prisma } from "@rakazo/db";
import { pageImagesNamedIn } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { MAX_FETCH_URL_LENGTH } from "../../approvals/approval-ask.js";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import type { EncodedPageImage } from "../../pages/page-image.js";
import {
  encodePageImage,
  fetchPageImage,
  PAGE_IMAGE_SOURCE_MAX_BYTES,
} from "../../pages/page-image.js";
import type { RunContext } from "../assembly/run-context.js";
import { PASSED_EFFECT_STATUSES } from "../lifecycle/run-effects.js";
import type { ToolCall } from "./run-tool-gate.js";

export type PageImageSources = Record<string, string>;

export function parsePageImageSources(value: unknown): PageImageSources | string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "images must be an object of names to sources.";
  const sources: PageImageSources = {};
  for (const [name, source] of Object.entries(value)) {
    if (!PAGE_IMAGE_NAME.test(name))
      return `Image name "${name.slice(0, 80)}" must be letters, digits, ".", "_" or "-", up to 64.`;
    if (typeof source !== "string" || !source.trim())
      return `Image ${name}: give a web address, a chat file's artifactId or a computer path.`;
    sources[name] = source.trim();
  }
  if (Object.keys(sources).length > PAGE_IMAGES_MAX)
    return `A page shows at most ${PAGE_IMAGES_MAX} images.`;
  return sources;
}

async function addressGiven(ctx: RunContext, url: string, site: string): Promise<boolean> {
  const rules = await ctx.trust.loadApprovalRules();
  if (resolveActionApprovalDetail({ toolName: "web_fetch", site, rules }).decision !== "allow")
    return false;
  if (ctx.trust.searchResultUrls.has(url)) return true;
  if ((await ctx.trust.loadTrustedSites()).has(site)) return true;
  if (siteAlwaysAllowed(rules, site)) return true;
  const fetched = await ctx.deps.prisma.externalEffect.findFirst({
    where: {
      runId: ctx.runId,
      kind: "web_fetch",
      status: { in: PASSED_EFFECT_STATUSES },
      request: { path: ["url"], equals: url },
    },
    select: { id: true },
  });
  return fetched !== null;
}

function reachableFiles(ctx: RunContext, ids: string[]) {
  const { run, bot, thread } = ctx;
  return {
    id: { in: ids },
    spaceId: run.spaceId,
    userId: run.userId,
    OR: thread.groupId ? [{ botId: bot.id }, { groupId: thread.groupId }] : [{ botId: bot.id }],
  };
}

export async function pageImageSourceLabels(
  ctx: RunContext,
  sources: PageImageSources,
): Promise<PageImageSources> {
  if (Object.keys(sources).length === 0) return sources;
  const files = await ctx.deps.prisma.artifact.findMany({
    where: reachableFiles(ctx, Object.values(sources)),
    select: { id: true, name: true },
  });
  const names = new Map(files.map((file) => [file.id, file.name]));
  return Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      names.has(source) ? `chat file ${names.get(source)}` : source,
    ]),
  );
}

async function pictureBytes(
  ctx: RunContext,
  call: ToolCall,
  source: string,
): Promise<Uint8Array | string> {
  const { deps, bot, context } = ctx;
  if (/^https?:\/\//i.test(source)) {
    const url = normalizedHttpUrl(source);
    const site = url ? urlSite(url) : undefined;
    if (!url || !site) return "not a valid web address";
    if (url.length > MAX_FETCH_URL_LENGTH)
      return `the address must be at most ${MAX_FETCH_URL_LENGTH} characters`;
    if (!ctx.tools.offered.some((tool) => tool.name === "web_fetch"))
      return "this bot cannot fetch web addresses";
    if (!(await addressGiven(ctx, url, site)))
      return `${site} needs approval first; open the address with web_fetch, then save again`;
    return fetchPageImage(url, { signal: context.signal });
  }
  const artifact = await deps.prisma.artifact.findFirst({
    where: reachableFiles(ctx, [source]),
    select: { storageKey: true, size: true },
  });
  if (artifact) {
    if (!deps.artifacts) return "file storage is unavailable";
    if (artifact.size > PAGE_IMAGE_SOURCE_MAX_BYTES) return "the picture is larger than 10 MB";
    return deps.artifacts.get(artifact.storageKey, context);
  }
  if (!ctx.tools.offered.some((tool) => tool.name === "read_file"))
    return "no chat file with that artifactId";
  try {
    return await deps.sandbox.readFile(
      await ctx.computer.get("tool", call.name),
      resolveBotWorkspacePath(ctx.computer.mode, bot.id, source),
      context,
      { maxBytes: PAGE_IMAGE_SOURCE_MAX_BYTES },
    );
  } catch {
    return "could not read a chat file with that artifactId or a computer file at that path";
  }
}

export async function preparePageImages(
  ctx: RunContext,
  call: ToolCall,
  sources: PageImageSources,
): Promise<{ images: Record<string, EncodedPageImage> } | { problems: string[] }> {
  const entries: (readonly [string, EncodedPageImage | string])[] = [];
  for (const [name, source] of Object.entries(sources)) {
    ctx.context.signal.throwIfAborted();
    const bytes = await pictureBytes(ctx, call, source);
    entries.push([name, typeof bytes === "string" ? bytes : await encodePageImage(bytes)]);
  }
  const problems = entries.flatMap(([name, image]) =>
    typeof image === "string" ? [`Image ${name}: ${image}.`] : [],
  );
  if (problems.length) return { problems };
  return {
    images: Object.fromEntries(
      entries.flatMap(([name, image]) => (typeof image === "string" ? [] : [[name, image]])),
    ),
  };
}

export function keptPageImageNames(
  previous: PageImages,
  added: PageImageSources,
  source: string,
): string[] {
  return Object.keys(pageImagesNamedIn({ ...previous, ...added }, source));
}

/** A picture ready for the save: bytes already in the artifact store, or one the page holds. */
export type StagedPageImage = Omit<EncodedPageImage, "bytes"> & {
  size: number;
  /** Set when this save stored the bytes; unset when the page already holds the same picture. */
  storageKey?: string;
};

/**
 * Puts each new picture's bytes in the artifact store, as for a chat file, before the save's
 * transaction, skipping pictures the page already holds. `discard` removes what the save stored
 * but did not keep.
 */
export async function stagePageImages(
  ctx: RunContext,
  pageId: string | undefined,
  images: Record<string, EncodedPageImage>,
): Promise<{
  staged: Record<string, StagedPageImage>;
  discard: (kept: string[]) => Promise<void>;
}> {
  const { deps, context } = ctx;
  const hashes = [...new Set(Object.values(images).map((image) => image.hash))];
  const held = new Set(
    pageId && hashes.length
      ? (
          await deps.prisma.pageImage.findMany({
            where: { pageId, hash: { in: hashes } },
            select: { hash: true },
          })
        ).map((image) => image.hash)
      : [],
  );
  const stored = new Map<string, string>();
  const discard = async (kept: string[]) => {
    const unused = [...stored.values()].filter((storageKey) => !kept.includes(storageKey));
    await Promise.all(
      unused.map((storageKey) =>
        bestEffort("remove an unsaved page picture", deps.artifacts!.remove(storageKey, context)),
      ),
    );
  };
  const staged: Record<string, StagedPageImage> = {};
  try {
    for (const [name, { bytes, ...image }] of Object.entries(images)) {
      let storageKey = stored.get(image.hash);
      if (!storageKey && !held.has(image.hash)) {
        if (!deps.artifacts) throw new Error("Page pictures need file storage");
        const put = await deps.artifacts.put(
          { name: `${name}.webp`, mimeType: image.mimeType, bytes },
          context,
        );
        storageKey = put.id;
        stored.set(image.hash, storageKey);
      }
      staged[name] = { ...image, size: bytes.byteLength, storageKey };
    }
  } catch (error) {
    await discard([]);
    throw error;
  }
  return { staged, discard };
}

/** Records the staged pictures on the page; returns the version's map and the bytes it kept. */
export async function storePageImages(
  tx: Prisma.TransactionClient,
  page: { id: string; spaceId: string },
  previous: PageImages,
  added: Record<string, StagedPageImage>,
  source: string,
): Promise<{ images: PageImages; kept: string[] }> {
  const ids: PageImages = {};
  const kept: string[] = [];
  for (const [name, { storageKey, ...image }] of Object.entries(added)) {
    const held = await tx.pageImage.findUnique({
      where: { pageId_hash: { pageId: page.id, hash: image.hash } },
      select: { id: true },
    });
    if (held) {
      ids[name] = held.id;
      continue;
    }
    // Held when staged, so a page that lost it since has changed under this save.
    if (!storageKey) throw new Error("A page picture went missing during the save");
    const created = await tx.pageImage.create({
      data: { ...image, storageKey, pageId: page.id, spaceId: page.spaceId },
      select: { id: true },
    });
    ids[name] = created.id;
    kept.push(storageKey);
  }
  return { images: pageImagesNamedIn({ ...previous, ...ids }, source), kept };
}
