import type { PageImageSource, PageImages } from "@rakazo/contracts";
import { PageImagesSchema } from "@rakazo/contracts";
import { readJsonColumn } from "../database/json-column.js";
import type { Prisma } from "../generated/prisma/client.js";

const StoredPageImages = PageImagesSchema.nullish().transform((images) => images ?? {});

type StoredVersion = { id: string; images: Prisma.JsonValue | null };

export function pageVersionImages(
  version: StoredVersion,
  onMismatch: "reject" | { fallback: PageImages } = { fallback: {} },
): PageImages {
  return readJsonColumn(
    StoredPageImages,
    version.images,
    { table: "page_versions", column: "images", id: version.id },
    onMismatch,
  );
}

/** Where a picture this version shows is stored, or null when the version does not show it. */
export type StoredPageImage = { spaceId: string; mimeType: string; storageKey: string };

export async function findPageVersionImage(
  db: Pick<Prisma.TransactionClient, "pageImage">,
  version: StoredVersion & { pageId: string },
  imageId: string,
): Promise<StoredPageImage | null> {
  const images = pageVersionImages(version, "reject");
  if (!Object.values(images).includes(imageId)) return null;
  return db.pageImage.findFirst({
    where: { id: imageId, pageId: version.pageId },
    select: { spaceId: true, mimeType: true, storageKey: true },
  });
}

export function pageImageSource(image: StoredPageImage, bytes: Uint8Array): PageImageSource {
  return { src: `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
}

/**
 * The stored pictures of the pages about to be deleted, read in the deleting transaction so the
 * caller can remove their bytes from the artifact store once it commits, as it does chat files.
 */
export async function pageImageStorageKeys(
  tx: Pick<Prisma.TransactionClient, "pageImage">,
  pages: Prisma.PageWhereInput,
): Promise<string[]> {
  const images = await tx.pageImage.findMany({
    where: { page: { is: pages } },
    select: { storageKey: true },
  });
  return images.map((image) => image.storageKey);
}

const IMAGE_REFERENCE = /(?<![\w-])image:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;

export function pageImageNames(source: string): Set<string> {
  return new Set([...source.matchAll(IMAGE_REFERENCE)].map((match) => match[1]!));
}

export function pageImagesNamedIn(images: PageImages, source: string): PageImages {
  const named = pageImageNames(source);
  return Object.fromEntries(Object.entries(images).filter(([name]) => named.has(name)));
}
