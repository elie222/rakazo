import { isDeepStrictEqual } from "node:util";
import type { PageState } from "@rakazo/contracts";
import {
  PAGE_STATE_KEY,
  PAGE_STATE_MAX_BYTES,
  PAGE_STATE_MAX_KEYS,
  PageStateSchema,
  pageStateBytes,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import * as z from "zod";
import { readJsonColumn } from "../database/json-column.js";
import type { Prisma } from "../generated/prisma/client.js";

type Db = Prisma.TransactionClient;

export class PageStateLimitError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message, "PAGE_STATE_LIMIT");
    this.name = "PageStateLimitError";
  }
}

const column = (id: string) => ({ table: "page_reader_states", column: "values", id });

type PageStateEntries = [string, unknown][];

const StoredPageState = z
  .array(z.tuple([z.string().regex(PAGE_STATE_KEY), z.unknown()]))
  .refine((entries) => PageStateSchema.safeParse(Object.fromEntries(entries)).success);

function storedEntries(row: { id: string; values: unknown }, onMismatch: "reject" | "fallback") {
  return readJsonColumn(
    StoredPageState,
    row.values,
    column(row.id),
    onMismatch === "reject" ? "reject" : { fallback: [] },
  );
}

export async function readPageState(db: Db, pageId: string, userId: string): Promise<PageState> {
  const row = await db.pageReaderState.findUnique({
    where: { pageId_userId: { pageId, userId } },
    select: { id: true, values: true },
  });
  return row ? Object.fromEntries(storedEntries(row, "fallback")) : {};
}

export function fitPageState(saved: PageStateEntries, values: PageState): PageStateEntries {
  let kept: PageStateEntries = [
    ...saved.filter(([key]) => !Object.hasOwn(values, key)),
    ...Object.entries(values),
  ];
  const changed = Object.keys(values).length;
  while (
    kept.length > changed &&
    (kept.length > PAGE_STATE_MAX_KEYS ||
      pageStateBytes(Object.fromEntries(kept)) > PAGE_STATE_MAX_BYTES)
  ) {
    kept = kept.slice(1);
  }
  return kept;
}

export async function savePageState(
  db: Db,
  page: { id: string; spaceId: string },
  userId: string,
  values: PageState,
): Promise<void> {
  const row = await db.pageReaderState.findUnique({
    where: { pageId_userId: { pageId: page.id, userId } },
    select: { id: true, values: true },
  });
  const saved = row ? storedEntries(row, "reject") : [];
  const merged = fitPageState(saved, values);
  if (row && isDeepStrictEqual(Object.fromEntries(merged), Object.fromEntries(saved))) return;
  const checked = PageStateSchema.safeParse(Object.fromEntries(merged));
  if (!checked.success) {
    throw new PageStateLimitError(checked.error.issues[0]?.message ?? "Too much to save");
  }
  if (row) {
    await db.pageReaderState.update({
      where: { id: row.id },
      data: { values: merged as Prisma.InputJsonArray },
    });
  } else {
    await db.pageReaderState.create({
      data: {
        pageId: page.id,
        userId,
        spaceId: page.spaceId,
        values: merged as Prisma.InputJsonArray,
      },
    });
  }
}
