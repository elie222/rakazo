import type { PageImageSource, PageImages } from "@rakazo/contracts";
import { PageImagesSchema } from "@rakazo/contracts";
import { readJsonColumn } from "../database/json-column.js";
import type { Prisma } from "../generated/prisma/client.js";

const StoredPageImages = PageImagesSchema.nullish().transform((images) => images ?? {});

type StoredVersion = { id: string; images: Prisma.JsonValue | null };

export function pageVersionImages(version: StoredVersion): PageImages {
  return readJsonColumn(
    StoredPageImages,
    version.images,
    { table: "page_versions", column: "images", id: version.id },
    { fallback: {} },
  );
}

export async function readPageVersionImage(
  db: Pick<Prisma.TransactionClient, "pageImage">,
  version: StoredVersion & { pageId: string },
  imageId: string,
): Promise<PageImageSource | null> {
  const images = readJsonColumn(
    StoredPageImages,
    version.images,
    { table: "page_versions", column: "images", id: version.id },
    "reject",
  );
  if (!Object.values(images).includes(imageId)) return null;
  const image = await db.pageImage.findFirst({
    where: { id: imageId, pageId: version.pageId },
    select: { mimeType: true, data: true },
  });
  return image ? { src: `data:${image.mimeType};base64,${image.data}` } : null;
}

const IMAGE_REFERENCE = /image:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;

export function pageImagesNamedIn(images: PageImages, source: string): PageImages {
  const named = new Set([...source.matchAll(IMAGE_REFERENCE)].map((match) => match[1]));
  return Object.fromEntries(Object.entries(images).filter(([name]) => named.has(name)));
}
