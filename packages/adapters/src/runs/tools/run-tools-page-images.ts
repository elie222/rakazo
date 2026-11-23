import type { PageImages } from "@rakazo/contracts";
import { PAGE_IMAGE_NAME, PAGE_IMAGES_MAX } from "@rakazo/contracts";
import { siteAlwaysAllowed } from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import type { Prisma } from "@rakazo/db";
import { pageImagesNamedIn } from "@rakazo/db";
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
  if (ctx.trust.searchResultUrls.has(url)) return true;
  if ((await ctx.trust.loadTrustedSites()).has(site)) return true;
  if (siteAlwaysAllowed(await ctx.trust.loadApprovalRules(), site)) return true;
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
    if (!(await addressGiven(ctx, url, site)))
      return `${site} is new to this chat; open the address with web_fetch first, then save again`;
    return fetchPageImage(url);
  }
  const artifact = await deps.prisma.artifact.findFirst({
    where: reachableFiles(ctx, [source]),
    select: { storageKey: true },
  });
  if (artifact) {
    if (!deps.artifacts) return "file storage is unavailable";
    return deps.artifacts
      .get(artifact.storageKey, context)
      .catch(() => "the file could not be read");
  }
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

export async function storePageImages(
  tx: Prisma.TransactionClient,
  page: { id: string; spaceId: string },
  previous: PageImages,
  added: Record<string, EncodedPageImage>,
  source: string,
): Promise<PageImages> {
  const ids: PageImages = {};
  for (const [name, image] of Object.entries(added)) {
    const stored =
      (await tx.pageImage.findUnique({
        where: { pageId_hash: { pageId: page.id, hash: image.hash } },
        select: { id: true },
      })) ??
      (await tx.pageImage.create({
        data: { ...image, pageId: page.id, spaceId: page.spaceId },
        select: { id: true },
      }));
    ids[name] = stored.id;
  }
  return pageImagesNamedIn({ ...previous, ...ids }, source);
}
